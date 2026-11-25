/**
 * Janela de lançamento (espelha expense_min_date no banco): vale o mais antigo entre o
 * início do ciclo atual e 20 dias atrás.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { minExpenseDate, setPreviousCycleOpen } from '@/lib/constants';

const dia = (d: Date) => `${d.getDate()}/${d.getMonth() + 1}`;

describe('minExpenseDate', () => {
  afterEach(() => {
    vi.useRealTimers();
    setPreviousCycleOpen(false);
  });

  it('fim do ciclo: libera o ciclo inteiro (24/11 → desde 25/10)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 24, 12));
    expect(dia(minExpenseDate())).toBe('25/10');
  });

  it('começo do ciclo: ainda vale 20 dias para trás (26/11 → desde 6/11)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 26, 12));
    expect(dia(minExpenseDate())).toBe('6/11');
  });

  it('segue o dia de corte da política', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 24, 12));
    expect(dia(minExpenseDate(10))).toBe('4/11');
  });

  it('relatório anterior aberto (ex.: devolvido): libera o ciclo anterior inteiro (25/11 → desde 25/10)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 25, 12));
    expect(dia(minExpenseDate())).toBe('5/11');
    setPreviousCycleOpen(true);
    expect(dia(minExpenseDate())).toBe('25/10');
  });
});
