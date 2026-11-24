-- Janela de lançamento e prazo do relatório (pedido do financeiro, 24/11/2026).
--
-- 1) Datas passadas: antes só "até 20 dias atrás"; no fim do ciclo isso cortava o
--    começo do próprio ciclo (em 24/11 não dava para lançar 25/10 a 03/11). Agora
--    vale o que for mais antigo entre o início do ciclo atual e 20 dias atrás: o
--    ciclo inteiro sempre entra, e no começo de um ciclo novo ainda dá para lançar
--    os últimos dias do anterior (que segue o fluxo de despesa fora do prazo).
-- 2) Prazo de envio: era o dia seguinte ao fim do ciclo (25); passa a ser o último
--    dia do ciclo (24). cycle_key e título não mudam (o mês de 24 e de 25 é o mesmo).
--
-- Só CREATE OR REPLACE de funções (versão que roda em produção) e uma função nova.

CREATE OR REPLACE FUNCTION public.expense_min_date(p_org uuid, p_today date)
RETURNS date
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT LEAST(p_today - 20, (SELECT cb.cycle_start FROM public.cycle_bounds(p_org, p_today) cb));
$$;

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
  IF p_date < public.expense_min_date(_org_id, _today) THEN
    RAISE EXCEPTION 'Só é possível lançar despesas a partir de %.', to_char(public.expense_min_date(_org_id, _today), 'DD/MM/YYYY');
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
    IF NEW.date < public.expense_min_date(NEW.org_id, _today) THEN
      RAISE EXCEPTION 'Só é possível lançar despesas a partir de %.', to_char(public.expense_min_date(NEW.org_id, _today), 'DD/MM/YYYY');
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

CREATE OR REPLACE FUNCTION public.get_or_create_current_report()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _user_id UUID;
  _org_id UUID;
  _policy RECORD;
  _today DATE;
  _cycle_start DATE;
  _cycle_end DATE;
  _due_date DATE;
  _cycle_key TEXT;
  _report RECORD;
  _report_title TEXT;
BEGIN
  _user_id := auth.uid();
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'User not authenticated';
  END IF;

  SELECT org_id INTO _org_id FROM public.profiles WHERE id = _user_id;
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'User has no organization';
  END IF;

  SELECT cycle_cutoff_day, timezone INTO _policy
  FROM public.expense_policies
  WHERE org_id = _org_id;

  IF NOT FOUND THEN
    INSERT INTO public.expense_policies (org_id) VALUES (_org_id)
    RETURNING cycle_cutoff_day, timezone INTO _policy;
  END IF;
  _policy.cycle_cutoff_day := COALESCE(_policy.cycle_cutoff_day, 25);
  _policy.timezone := COALESCE(_policy.timezone, 'America/Sao_Paulo');

  _today := (now() AT TIME ZONE _policy.timezone)::DATE;

  IF EXTRACT(DAY FROM _today) < _policy.cycle_cutoff_day THEN
    _cycle_start := date_trunc('month', _today - interval '1 month')::DATE + (_policy.cycle_cutoff_day - 1);
  ELSE
    _cycle_start := date_trunc('month', _today)::DATE + (_policy.cycle_cutoff_day - 1);
  END IF;

  _cycle_end := (_cycle_start + interval '1 month')::DATE - 1;
  _due_date := _cycle_end;  -- prazo = último dia do ciclo (era o dia seguinte)
  _cycle_key := to_char(_due_date, 'YYYY-MM');

  SELECT * INTO _report
  FROM public.reports
  WHERE org_id = _org_id
    AND user_id = _user_id
    AND cycle_key = _cycle_key;

  IF NOT FOUND THEN
    _report_title := 'Relatório ' ||
      CASE EXTRACT(MONTH FROM _due_date)
        WHEN 1 THEN 'Jan' WHEN 2 THEN 'Fev' WHEN 3 THEN 'Mar' WHEN 4 THEN 'Abr'
        WHEN 5 THEN 'Mai' WHEN 6 THEN 'Jun' WHEN 7 THEN 'Jul' WHEN 8 THEN 'Ago'
        WHEN 9 THEN 'Set' WHEN 10 THEN 'Out' WHEN 11 THEN 'Nov' WHEN 12 THEN 'Dez'
      END || ' ' || EXTRACT(YEAR FROM _due_date);

    INSERT INTO public.reports (org_id, user_id, title, start_date, end_date, due_date, cycle_key, status)
    VALUES (_org_id, _user_id, _report_title, _cycle_start, _cycle_end, _due_date, _cycle_key, 'draft')
    RETURNING * INTO _report;
  END IF;

  RETURN json_build_object(
    'id', _report.id,
    'title', _report.title,
    'start_date', _report.start_date,
    'end_date', _report.end_date,
    'due_date', _report.due_date,
    'cycle_key', _report.cycle_key,
    'status', _report.status,
    'created_at', _report.created_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_or_create_report_for_date(p_date date)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _user_id UUID;
  _org_id UUID;
  _policy RECORD;
  _cycle_start DATE;
  _cycle_end DATE;
  _due_date DATE;
  _cycle_key TEXT;
  _report RECORD;
  _report_title TEXT;
BEGIN
  _user_id := auth.uid();
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'User not authenticated';
  END IF;

  SELECT org_id INTO _org_id FROM public.profiles WHERE id = _user_id;
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'User has no organization';
  END IF;

  SELECT cycle_cutoff_day, timezone INTO _policy
  FROM public.expense_policies
  WHERE org_id = _org_id;

  IF NOT FOUND THEN
    INSERT INTO public.expense_policies (org_id) VALUES (_org_id)
    RETURNING cycle_cutoff_day, timezone INTO _policy;
  END IF;
  _policy.cycle_cutoff_day := COALESCE(_policy.cycle_cutoff_day, 25);

  IF EXTRACT(DAY FROM p_date) >= _policy.cycle_cutoff_day THEN
    _cycle_start := date_trunc('month', p_date)::DATE + (_policy.cycle_cutoff_day - 1);
  ELSE
    _cycle_start := date_trunc('month', p_date - interval '1 month')::DATE + (_policy.cycle_cutoff_day - 1);
  END IF;

  _cycle_end := (_cycle_start + interval '1 month')::DATE - 1;
  _due_date := _cycle_end;  -- prazo = último dia do ciclo (era o dia seguinte)
  _cycle_key := to_char(_due_date, 'YYYY-MM');

  SELECT * INTO _report
  FROM public.reports
  WHERE org_id = _org_id
    AND user_id = _user_id
    AND cycle_key = _cycle_key;

  IF NOT FOUND THEN
    _report_title := 'Relatório ' ||
      CASE EXTRACT(MONTH FROM _due_date)
        WHEN 1 THEN 'Jan' WHEN 2 THEN 'Fev' WHEN 3 THEN 'Mar' WHEN 4 THEN 'Abr'
        WHEN 5 THEN 'Mai' WHEN 6 THEN 'Jun' WHEN 7 THEN 'Jul' WHEN 8 THEN 'Ago'
        WHEN 9 THEN 'Set' WHEN 10 THEN 'Out' WHEN 11 THEN 'Nov' WHEN 12 THEN 'Dez'
      END || ' ' || EXTRACT(YEAR FROM _due_date);

    INSERT INTO public.reports (org_id, user_id, title, start_date, end_date, due_date, cycle_key, status)
    VALUES (_org_id, _user_id, _report_title, _cycle_start, _cycle_end, _due_date, _cycle_key, 'draft')
    ON CONFLICT (org_id, user_id, cycle_key) WHERE cycle_key IS NOT NULL DO NOTHING;
    SELECT * INTO _report FROM public.reports
     WHERE org_id = _org_id AND user_id = _user_id AND cycle_key = _cycle_key;
  END IF;

  RETURN json_build_object(
    'id', _report.id,
    'title', _report.title,
    'start_date', _report.start_date,
    'end_date', _report.end_date,
    'due_date', _report.due_date,
    'cycle_key', _report.cycle_key,
    'status', _report.status,
    'submitted_at', _report.submitted_at,
    'submitted_late', _report.submitted_late,
    'created_at', _report.created_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.decide_late_expense(p_expense_id uuid, p_destino text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid(); _org uuid; _e record; _r record; _next_date date; _title text;
  _cstart date; _cend date; _key text;
BEGIN
  IF _uid IS NULL OR NOT public.is_manager_or_admin(_uid) THEN
    RAISE EXCEPTION 'Apenas gestores decidem despesas fora do prazo.';
  END IF;
  SELECT org_id INTO _org FROM public.profiles WHERE id = _uid;
  SELECT * INTO _e FROM public.expenses WHERE id = p_expense_id AND org_id = _org AND late_decision = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'Despesa não encontrada ou já decidida.'; END IF;

  IF p_destino = 'this_month' THEN
    SELECT cb.cycle_start INTO _cstart FROM public.cycle_bounds(_org, _e.date) cb;
    SELECT * INTO _r FROM public.reports
     WHERE org_id = _org AND user_id = _e.user_id AND start_date = _cstart;
    IF NOT FOUND OR _r.status = 'paid' THEN
      RAISE EXCEPTION 'O relatório deste mês já foi pago — passe a despesa para o mês seguinte.';
    END IF;
    INSERT INTO public.report_items (report_id, expense_id) VALUES (_r.id, _e.id);
    -- Entra no estado do relatório: enviado segue para a aprovação; aprovado já
    -- sai aprovado, porque decidir "neste mês" é o gestor aprovando.
    UPDATE public.expenses SET late_decision = 'this_month',
      status = CASE _r.status WHEN 'approved' THEN 'approved'::expense_status
                              WHEN 'submitted' THEN 'submitted'::expense_status
                              ELSE 'draft'::expense_status END
     WHERE id = _e.id;
  ELSIF p_destino = 'next_month' THEN
    SELECT cb.cycle_end + 1 INTO _next_date FROM public.cycle_bounds(_org, _e.date) cb;
    SELECT cb.cycle_start, cb.cycle_end INTO _cstart, _cend FROM public.cycle_bounds(_org, _next_date) cb;
    _key := to_char(_cend + 1, 'YYYY-MM');
    SELECT * INTO _r FROM public.reports WHERE org_id = _org AND user_id = _e.user_id AND cycle_key = _key;
    IF NOT FOUND THEN
      _title := 'Relatório ' || (ARRAY['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'])[EXTRACT(MONTH FROM _cend + 1)::int]
                || ' ' || EXTRACT(YEAR FROM _cend + 1);
      INSERT INTO public.reports (org_id, user_id, title, start_date, end_date, due_date, cycle_key, status)
      VALUES (_org, _e.user_id, _title, _cstart, _cend, _cend, _key, 'draft') RETURNING * INTO _r;
    ELSIF _r.status <> 'draft' THEN
      RAISE EXCEPTION 'O relatório do mês seguinte já foi enviado.';
    END IF;
    INSERT INTO public.report_items (report_id, expense_id) VALUES (_r.id, _e.id);
    UPDATE public.expenses SET late_decision = 'next_month' WHERE id = _e.id;
  ELSE
    RAISE EXCEPTION 'Destino inválido: use this_month ou next_month.';
  END IF;

  PERFORM public.create_notification(
    _e.user_id, 'my_expenses', 'Despesa fora do prazo decidida',
    format('"%s" entrou no %s.', _e.description, _r.title), format('/app/reports/%s', _r.id));
  RETURN json_build_object('report_id', _r.id, 'report_title', _r.title, 'destino', p_destino);
END;
$function$;
