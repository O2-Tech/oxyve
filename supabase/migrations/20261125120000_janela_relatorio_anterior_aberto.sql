-- Janela de lançamento com o relatório anterior aberto (25/11/2026).
--
-- Na virada do ciclo a regra "início do ciclo atual ou 20 dias" cortava o ciclo
-- anterior, e um relatório devolvido (ex.: o de novembro do Ícaro, reprovado por
-- falta de comprovante) não podia receber as notas que faltavam. Agora, enquanto o
-- relatório do ciclo anterior da pessoa não foi enviado (rascunho, devolvido ou ainda
-- inexistente), o ciclo anterior inteiro entra. Quem já enviou segue a regra de antes.
--
-- Função nova com o usuário; expense_min_date(org, data) fica como está.

CREATE OR REPLACE FUNCTION public.expense_min_date_for(p_org uuid, p_user uuid, p_today date)
RETURNS date
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH c AS (
    SELECT cb.cycle_start AS cur FROM public.cycle_bounds(p_org, p_today) cb
  ), p AS (
    SELECT pb.cycle_start AS prev FROM c, public.cycle_bounds(p_org, c.cur - 1) pb
  )
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM public.reports r, p
       WHERE r.org_id = p_org AND r.user_id = p_user AND r.start_date = p.prev AND r.status <> 'draft'
    ) THEN public.expense_min_date(p_org, p_today)
    ELSE LEAST(public.expense_min_date(p_org, p_today), (SELECT prev FROM p))
  END;
$$;

REVOKE ALL ON FUNCTION public.expense_min_date_for(uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.expense_min_date_for(uuid, uuid, date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_expense_in_current_report(p_description text, p_amount_cents integer, p_date date, p_category_id uuid DEFAULT NULL::uuid, p_cost_center_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_payment_method text DEFAULT 'personal_card'::text, p_currency text DEFAULT 'BRL'::text, p_is_reimbursable boolean DEFAULT true, p_notes text DEFAULT NULL::text, p_receipt_path text DEFAULT NULL::text, p_is_event boolean DEFAULT false, p_distance_km numeric DEFAULT NULL::numeric, p_food_days integer DEFAULT 1, p_receipt_hash text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _user_id uuid := auth.uid(); _org_id uuid; _report json; _late boolean;
  _expense_id uuid; _expense record; _author text; _admin uuid;
  _today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'User not authenticated'; END IF;
  SELECT org_id, full_name INTO _org_id, _author FROM public.profiles WHERE id = _user_id;
  IF _org_id IS NULL THEN RAISE EXCEPTION 'User has no organization'; END IF;

  IF p_is_event AND (p_notes IS NULL OR btrim(p_notes) = '') THEN
    RAISE EXCEPTION 'Despesa marcada como evento exige uma observação descrevendo o motivo da exceção (política de reembolso).';
  END IF;
  IF p_date > _today THEN RAISE EXCEPTION 'A data da despesa não pode ser futura.'; END IF;
  IF p_date < public.expense_min_date_for(_org_id, _user_id, _today) THEN
    RAISE EXCEPTION 'Só é possível lançar despesas a partir de %.', to_char(public.expense_min_date_for(_org_id, _user_id, _today), 'DD/MM/YYYY');
  END IF;

  _report := public.get_or_create_report_for_date(p_date);
  _late := (_report->>'status') <> 'draft';

  INSERT INTO public.expenses (
    org_id, user_id, description, amount_cents, date, category_id, cost_center_id, project_id,
    payment_method, currency, is_reimbursable, notes, receipt_path, is_event, distance_km,
    food_days, status, late_decision, receipt_hash)
  VALUES (
    _org_id, _user_id, p_description, p_amount_cents, p_date, p_category_id, p_cost_center_id, p_project_id,
    p_payment_method::payment_method, p_currency, p_is_reimbursable, p_notes, p_receipt_path, p_is_event, p_distance_km,
    GREATEST(COALESCE(p_food_days, 1), 1), 'draft', CASE WHEN _late THEN 'pending' END, p_receipt_hash)
  RETURNING id INTO _expense_id;

  IF _late THEN
    FOR _admin IN
      SELECT DISTINCT ur.user_id FROM public.user_roles ur JOIN public.profiles p ON p.id = ur.user_id
       WHERE p.org_id = _org_id AND ur.role IN ('admin', 'manager') AND ur.user_id <> _user_id
    LOOP
      PERFORM public.create_notification(
        _admin, 'action_required', 'Despesa fora do prazo',
        format('%s lançou "%s" (R$ %s) depois do envio do %s. Decida se entra neste mês ou no próximo.',
               COALESCE(_author, 'Um colaborador'), p_description,
               public.brl(p_amount_cents), _report->>'title'),
        '/app/gestao');
    END LOOP;
  ELSE
    INSERT INTO public.report_items (report_id, expense_id) VALUES ((_report->>'id')::uuid, _expense_id);
  END IF;

  SELECT * INTO _expense FROM public.expenses WHERE id = _expense_id;
  RETURN json_build_object(
    'expense', row_to_json(_expense),
    'report', CASE WHEN _late THEN NULL ELSE _report END,
    'late', _late,
    'late_report', CASE WHEN _late THEN _report END,
    'is_out_of_policy', _expense.is_out_of_policy,
    'possible_duplicate', _expense.possible_duplicate_of IS NOT NULL,
    'possible_duplicate_of', _expense.possible_duplicate_of);
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_expenses_regras()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  _kind text; _limit int; _start date; _end date;
  _month_used bigint; _day_used bigint; _cap bigint;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.date IS DISTINCT FROM OLD.date THEN
    IF NEW.date > _today THEN
      RAISE EXCEPTION 'A data da despesa não pode ser futura.';
    END IF;
    IF NEW.date < public.expense_min_date_for(NEW.org_id, NEW.user_id, _today) THEN
      RAISE EXCEPTION 'Só é possível lançar despesas a partir de %.', to_char(public.expense_min_date_for(NEW.org_id, NEW.user_id, _today), 'DD/MM/YYYY');
    END IF;
  END IF;

  IF NEW.receipt_hash IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.receipt_hash IS DISTINCT FROM OLD.receipt_hash) THEN
    PERFORM 1 FROM public.expenses e
     WHERE e.user_id = NEW.user_id AND e.receipt_hash = NEW.receipt_hash
       AND e.status <> 'rejected' AND e.id <> NEW.id;
    IF FOUND THEN
      RAISE EXCEPTION 'Este comprovante já foi lançado em outra despesa. Se for outra nota, fotografe a nota correta.';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.date IS DISTINCT FROM OLD.date OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
     OR NEW.category_id IS DISTINCT FROM OLD.category_id
     OR NEW.possible_duplicate_of IS DISTINCT FROM OLD.possible_duplicate_of THEN
    SELECT e.id INTO NEW.possible_duplicate_of FROM public.expenses e
     WHERE e.user_id = NEW.user_id AND e.date = NEW.date AND e.amount_cents = NEW.amount_cents
       AND e.category_id IS NOT DISTINCT FROM NEW.category_id
       AND e.status <> 'rejected' AND e.id <> NEW.id
     ORDER BY e.created_at, e.id
     LIMIT 1;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.amount_cents IS NOT DISTINCT FROM OLD.amount_cents
     AND NEW.date IS NOT DISTINCT FROM OLD.date
     AND NEW.category_id IS NOT DISTINCT FROM OLD.category_id
     AND NEW.food_days IS NOT DISTINCT FROM OLD.food_days
     AND NEW.is_event IS NOT DISTINCT FROM OLD.is_event
     AND NEW.is_reimbursable IS NOT DISTINCT FROM OLD.is_reimbursable
     AND NEW.reimbursable_cents IS NOT DISTINCT FROM OLD.reimbursable_cents
     AND NEW.is_out_of_policy IS NOT DISTINCT FROM OLD.is_out_of_policy
     AND NEW.reimbursable_cents IS NOT NULL THEN
    RETURN NEW;
  END IF;

  NEW.reimbursable_cents := NEW.amount_cents;
  SELECT kind INTO _kind FROM public.expense_categories WHERE id = NEW.category_id;

  IF NOT NEW.is_reimbursable THEN
    NEW.is_out_of_policy := NEW.is_event;
    RETURN NEW;
  END IF;

  IF _kind IS DISTINCT FROM 'food' THEN
    NEW.is_out_of_policy := NEW.is_event;
    RETURN NEW;
  END IF;
  IF NEW.is_event THEN
    NEW.is_out_of_policy := true;
    RETURN NEW;
  END IF;

  SELECT food_daily_limit_cents INTO _limit FROM public.expense_policies WHERE org_id = NEW.org_id;
  IF _limit IS NULL OR _limit <= 0 THEN
    NEW.is_out_of_policy := false;
    RETURN NEW;
  END IF;

  SELECT cb.cycle_start, cb.cycle_end INTO _start, _end FROM public.cycle_bounds(NEW.org_id, NEW.date) cb;

  SELECT COALESCE(SUM(COALESCE(e.reimbursable_cents, e.amount_cents)), 0) INTO _month_used
    FROM public.expenses e JOIN public.expense_categories ec ON ec.id = e.category_id
   WHERE e.user_id = NEW.user_id AND ec.kind = 'food' AND NOT e.is_event AND e.is_reimbursable
     AND e.date BETWEEN _start AND _end AND e.status <> 'rejected' AND e.id <> NEW.id;

  IF NEW.food_days > 1 THEN
    _cap := NEW.food_days::bigint * _limit;
  ELSE
    SELECT COALESCE(SUM(COALESCE(e.reimbursable_cents, e.amount_cents)), 0) INTO _day_used
      FROM public.expenses e JOIN public.expense_categories ec ON ec.id = e.category_id
     WHERE e.user_id = NEW.user_id AND ec.kind = 'food' AND NOT e.is_event AND e.is_reimbursable
       AND e.food_days = 1 AND e.date = NEW.date AND e.status <> 'rejected' AND e.id <> NEW.id;
    _cap := GREATEST(_limit - _day_used, 0);
  END IF;

  _cap := LEAST(_cap, GREATEST(public.business_days(_start, _end)::bigint * _limit - _month_used, 0));
  NEW.reimbursable_cents := LEAST(NEW.amount_cents::bigint, _cap)::int;
  NEW.is_out_of_policy := false;
  RETURN NEW;
END;
$function$;
