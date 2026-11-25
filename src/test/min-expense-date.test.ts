/**
 * Janela de lançamento (espelha expense_min_date no banco): vale o mais antigo entre o
 * início do ciclo atual e 60 dias atrás.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { minExpenseDate, setPreviousCycleOpen } from '@/lib/constants';

const dia = (d: Date) => `${d.getDate()}/${d.getMonth() + 1}`;

describe('minExpenseDate', () => {
  afterEach(() => {
    vi.useRealTimers();
    setPreviousCycleOpen(false);
  });

  it('60 dias para trás (24/11 → desde 25/9)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 24, 12));
    expect(dia(minExpenseDate())).toBe('25/9');
  });

  it('começo do ciclo: 60 dias para trás (26/11 → desde 27/9)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 26, 12));
    expect(dia(minExpenseDate())).toBe('27/9');
  });

  it('ciclo mais longo que 60 dias para trás: vale o início do ciclo anterior aberto', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 11, 24, 12));
    expect(dia(minExpenseDate())).toBe('25/10');
    setPreviousCycleOpen(true);
    expect(dia(minExpenseDate())).toBe('25/10');
  });

  it('hoje (25/11): desde 26/9, com ou sem relatório anterior aberto', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 25, 12));
    expect(dia(minExpenseDate())).toBe('26/9');
    setPreviousCycleOpen(true);
    expect(dia(minExpenseDate())).toBe('26/9');
  });
});
