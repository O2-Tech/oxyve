-- Janela de lançamento de 60 dias (25/11/2026).
--
-- 20 dias cortava notas antigas que ainda precisavam entrar (ex.: as do Ícaro).
-- Agora vale o mais antigo entre o início do ciclo atual e 60 dias atrás
-- (e o ciclo anterior inteiro, via expense_min_date_for, segue igual).

CREATE OR REPLACE FUNCTION public.expense_min_date(p_org uuid, p_today date)
RETURNS date
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT LEAST(p_today - 60, (SELECT cb.cycle_start FROM public.cycle_bounds(p_org, p_today) cb));
$$;
