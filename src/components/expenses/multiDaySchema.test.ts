import { describe, it, expect } from 'vitest';
import { multiDayCount, multiDayRanges, multiDaySchema } from './multiDaySchema';

const base = () => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return {
    category_id: 'c1',
    start_date: today,
    end_date: today,
    amount_per_day: '30,00',
    description: 'Almoço',
    is_event: false,
    notes: '',
    weekdays_only: false,
  };
};

const daysAgo = (n: number) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
};

describe('multiDaySchema', () => {
  it('aceita valor com ponto de milhar e período dentro da janela', () => {
    expect(multiDaySchema.safeParse({ ...base(), amount_per_day: '1.200', start_date: daysAgo(3) }).success).toBe(true);
  });

  it.each(['abc', '-5', '0'])('recusa valor inválido %s', (amount) => {
    expect(multiDaySchema.safeParse({ ...base(), amount_per_day: amount }).success).toBe(false);
  });

  it('recusa início além da janela de lançamento', () => {
    // 60 dias: sempre antes da janela (início do ciclo, no máximo ~31 dias, ou 20 dias).
    const r = multiDaySchema.safeParse({ ...base(), start_date: daysAgo(60) });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/a partir de/);
  });

  it('recusa fim no futuro', () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(multiDaySchema.safeParse({ ...base(), end_date: tomorrow }).success).toBe(false);
  });
});

describe('só dias úteis', () => {
  // 21/11/2026 é sábado; 23/11 é segunda.
  const d = (day: number, month = 11) => new Date(2026, month - 1, day);
  const ymd = (x: Date) => `${x.getDate()}/${x.getMonth() + 1}`;

  it('sem a opção, o período inteiro é um bloco só', () => {
    expect(multiDayRanges(d(20), d(24), false).map((r) => [ymd(r.start), ymd(r.end)])).toEqual([['20/11', '24/11']]);
    expect(multiDayCount(d(20), d(24), false)).toBe(5);
  });

  it('com a opção, pula sábado e domingo e quebra em blocos de segunda a sexta', () => {
    expect(multiDayRanges(d(25, 10), d(24), true).map((r) => [ymd(r.start), ymd(r.end)])).toEqual([
      ['26/10', '30/10'],
      ['2/11', '6/11'],
      ['9/11', '13/11'],
      ['16/11', '20/11'],
      ['23/11', '24/11'],
    ]);
    expect(multiDayCount(d(25, 10), d(24), true)).toBe(22);
  });

  it('período só de fim de semana não tem dia útil', () => {
    expect(multiDayRanges(d(21), d(22), true)).toEqual([]);
    expect(multiDayCount(d(21), d(22), true)).toBe(0);
  });
});
