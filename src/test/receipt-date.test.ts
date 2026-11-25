/**
 * Data da nota diferente do dia da despesa: não bloqueia, só avisa (o gestor vê o
 * selo). PIX, cartão sem NF e sem CNPJ continuam bloqueando.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
import { format, subDays, addDays } from 'date-fns';
import { receiptPolicyBlocks, receiptDateNotice, type ValidationResult } from '@/hooks/useValidateReceipt';
import { receiptDateDiffers, receiptDateHint } from '@/lib/receiptDate';
import { minExpenseDate } from '@/lib/constants';

const ymd = (d: Date) => format(d, 'yyyy-MM-dd');
const today = ymd(new Date());
const br = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;

const base: ValidationResult = {
  extracted_date: today,
  extracted_amount_cents: 5000,
  extracted_cnpj: '11222333000181',
  extracted_supplier: 'Rest',
  receipt_type: 'nota_fiscal',
  confidence: 'high',
  amount_confidence: 'high',
  date_confidence: 'high',
  issues: [],
  expense_kind_hint: null,
  model_used: null,
};

describe('receiptPolicyBlocks', () => {
  it('data divergente não bloqueia', () => {
    expect(receiptPolicyBlocks({ ...base, extracted_date: ymd(subDays(new Date(), 3)) })).toEqual([]);
  });
  it('PIX e cartão sem NF seguem bloqueando', () => {
    expect(receiptPolicyBlocks({ ...base, receipt_type: 'comprovante_pix' })[0]).toMatch(/PIX/);
    expect(receiptPolicyBlocks({ ...base, receipt_type: 'comprovante_cartao' })[0]).toMatch(/cartão/);
  });
  it('sem CNPJ lido não bloqueia mais (a leitura pode não enxergar o CNPJ da foto)', () => {
    expect(receiptPolicyBlocks({ ...base, receipt_type: 'recibo', extracted_cnpj: null })).toEqual([]);
  });
});

describe('receiptDateNotice', () => {
  it('mesma data: sem aviso', () => {
    expect(receiptDateNotice(base, today)).toBeNull();
  });
  it('data diferente dentro da janela: aviso amarelo para quem lança', () => {
    const d = ymd(subDays(new Date(), 3));
    expect(receiptDateNotice({ ...base, extracted_date: d }, today)).toBe(
      `A data da nota (${br(d)}) é diferente da data da despesa. O gestor verá esse aviso.`,
    );
  });
  it('nota antes da janela de lançamento: despesa fica com hoje', () => {
    const d = ymd(subDays(new Date(), 90));
    expect(receiptDateNotice({ ...base, extracted_date: d }, today)).toBe(
      `Essa nota é de ${br(d)}, antes de ${br(ymd(minExpenseDate()))}, a data mais antiga que ainda dá para lançar. Ela entra com a data de hoje e o gestor vê a data da nota e decide se aprova.`,
    );
    expect(receiptDateNotice({ ...base, extracted_date: ymd(addDays(new Date(), 2)) }, today)).toMatch(/está no futuro/);
  });
});

describe('selo do gestor', () => {
  it('só quando a data da nota existe e difere', () => {
    expect(receiptDateDiffers('2026-09-21', '2026-10-20')).toBe(true);
    expect(receiptDateDiffers('2026-10-20', '2026-10-20')).toBe(false);
    expect(receiptDateDiffers(null, '2026-10-20')).toBe(false);
    expect(receiptDateHint('2026-09-21', '2026-10-20')).toBe('Nota de 21/09/2026 · despesa em 20/10/2026');
  });
});
