-- Notas do mesmo dia (26/11/2026).
--
-- 1) Apagar, reprovar ou trocar de dia uma despesa não recalculava as outras do
--    mesmo dia: a que sobrava ficava com reembolso R$ 0 (teto já usado) e com o selo
--    de possível duplicidade apontando para quem nem estava mais lá. Agora um gatilho
--    AFTER recalcula as despesas em rascunho daquele dia, na ordem de lançamento.
-- 2) Possível duplicidade: mesma data + valor + categoria só conta se uma das duas
--    não tem foto ou se o fornecedor (descrição) é o mesmo. Notas com foto de lugares
--    diferentes no mesmo dia não são duplicidade.

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
     OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.receipt_hash IS DISTINCT FROM OLD.receipt_hash
     OR NEW.possible_duplicate_of IS DISTINCT FROM OLD.possible_duplicate_of THEN
    -- Duas notas com foto (hashes diferentes) de fornecedores diferentes não são
    -- duplicidade: é só mais de uma refeição no dia (o teto diário já cuida).
    SELECT e.id INTO NEW.possible_duplicate_of FROM public.expenses e
     WHERE e.user_id = NEW.user_id AND e.date = NEW.date AND e.amount_cents = NEW.amount_cents
       AND e.category_id IS NOT DISTINCT FROM NEW.category_id
       AND (e.receipt_hash IS NULL OR NEW.receipt_hash IS NULL
            OR lower(btrim(e.description)) = lower(btrim(NEW.description)))
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

CREATE OR REPLACE FUNCTION public.tg_expenses_recalcula_dia()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _id uuid;
BEGIN
  -- Só as em rascunho: aprovada ou paga não muda de valor por tabela.
  FOR _id IN
    SELECT e.id FROM public.expenses e
     WHERE e.user_id = OLD.user_id AND e.date = OLD.date AND e.id <> OLD.id AND e.status = 'draft'
     ORDER BY e.created_at, e.id
  LOOP
    -- reimbursable_cents NULL força o recálculo do teto em tg_expenses_regras;
    -- possible_duplicate_of NULL força procurar de novo a duplicidade.
    UPDATE public.expenses SET reimbursable_cents = NULL, possible_duplicate_of = NULL WHERE id = _id;
  END LOOP;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.tg_expenses_recalcula_dia() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER expenses_recalcula_dia
AFTER DELETE OR UPDATE OF date, amount_cents, category_id, status, food_days, is_event, is_reimbursable, description, receipt_hash
ON public.expenses
FOR EACH ROW EXECUTE FUNCTION public.tg_expenses_recalcula_dia();
