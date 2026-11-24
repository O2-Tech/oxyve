import { z } from 'zod';
import { amountFieldError, endOfToday, minExpenseDate } from '@/lib/constants';

// Schema do lançamento de vários dias (separado para teste). Valor pelo mesmo parser do
// formulário avulso: parseFloat lia "1.200" (hospedagem) como R$ 1,20 por dia, sem aviso.
export const multiDaySchema = z
  .object({
    category_id: z.string().min(1, 'Escolha a categoria'),
    start_date: z.date({ required_error: 'Data inicial obrigatória' }),
    end_date: z.date({ required_error: 'Data final obrigatória' }),
    amount_per_day: z
      .string()
      .min(1, 'Informe o valor por dia')
      .refine((v) => !amountFieldError(v), (v) => ({ message: amountFieldError(v) ?? '' })),
    description: z.string().min(1, 'Descrição obrigatória'),
    is_event: z.boolean(),
    notes: z.string().optional(),
    // Só segunda a sexta: refeição de dia de trabalho não entra no fim de semana.
    weekdays_only: z.boolean(),
  })
  .refine((d) => d.end_date >= d.start_date, {
    message: 'A data final deve ser igual ou posterior à inicial',
    path: ['end_date'],
  })
  // Evento (libera o teto diário) exige justificativa escrita.
  .superRefine((d, ctx) => {
    // Mesma janela do gatilho do banco: fora dela a RPC (atômica) recusava o lote inteiro.
    if (d.start_date < minExpenseDate()) {
      ctx.addIssue({
        path: ['start_date'],
        code: z.ZodIssueCode.custom,
        message: `Só dá para lançar despesas a partir de ${minExpenseDate().toLocaleDateString('pt-BR')}`,
      });
    }
    if (d.end_date > endOfToday()) {
      ctx.addIssue({
        path: ['end_date'],
        code: z.ZodIssueCode.custom,
        message: 'A data final não pode ser no futuro',
      });
    }
    if (d.is_event && (!d.notes || d.notes.trim().length < 3)) {
      ctx.addIssue({
        path: ['notes'],
        code: z.ZodIssueCode.custom,
        message: 'Descreva o motivo da exceção de evento.',
      });
    }
  });

const isWeekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6;

/**
 * Períodos contínuos a lançar entre `start` e `end` (inclusive). Com `weekdaysOnly`,
 * quebra em blocos de segunda a sexta, pulando sábado e domingo; sem, é um bloco só.
 */
export function multiDayRanges(start: Date, end: Date, weekdaysOnly: boolean): Array<{ start: Date; end: Date }> {
  if (end < start) return [];
  if (!weekdaysOnly) return [{ start, end }];
  const ranges: Array<{ start: Date; end: Date }> = [];
  let open: Date | null = null;
  let last: Date | null = null;
  for (let d = new Date(start); d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    if (isWeekend(d)) {
      if (open && last) ranges.push({ start: open, end: last });
      open = null;
      continue;
    }
    open ??= d;
    last = d;
  }
  if (open && last) ranges.push({ start: open, end: last });
  return ranges;
}

/** Quantos dias o lançamento cria (um por dia dos períodos). */
export function multiDayCount(start: Date | undefined, end: Date | undefined, weekdaysOnly: boolean): number {
  if (!start || !end) return 0;
  return multiDayRanges(start, end, weekdaysOnly).reduce(
    (n, r) => n + Math.round((r.end.getTime() - r.start.getTime()) / 86_400_000) + 1,
    0,
  );
}
