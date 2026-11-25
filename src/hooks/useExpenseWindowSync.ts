/**
 * Mantém a janela de lançamento do app igual à do banco (expense_min_date_for):
 * enquanto o relatório do ciclo anterior da pessoa não foi enviado, o ciclo anterior
 * inteiro pode receber despesas — ex.: relatório devolvido que precisa das notas.
 */
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useExpensePolicy } from '@/hooks/usePolicy';
import { cycleForDate, DEFAULT_CYCLE_CUTOFF_DAY } from '@/hooks/useCurrentReport';
import { setPreviousCycleOpen } from '@/lib/constants';

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function useExpenseWindowSync() {
  const { user } = useAuth();
  const { data: policy } = useExpensePolicy();
  const cutoff = policy?.cycle_cutoff_day || DEFAULT_CYCLE_CUTOFF_DAY;
  const current = cycleForDate(ymd(new Date()), cutoff);
  const previous = cycleForDate(
    ymd(new Date(Number(current.start_date.slice(0, 4)), Number(current.start_date.slice(5, 7)) - 1, Number(current.start_date.slice(8, 10)) - 1)),
    cutoff,
  );

  const { data: open } = useQuery({
    queryKey: ['previous-cycle-open', user?.id, previous.start_date],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('reports')
        .select('status')
        .eq('user_id', user!.id)
        .eq('start_date', previous.start_date)
        .maybeSingle();
      if (error) throw error;
      return !data || data.status === 'draft';
    },
  });

  useEffect(() => {
    setPreviousCycleOpen(open === true);
  }, [open]);
}
