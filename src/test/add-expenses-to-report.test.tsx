/**
 * Adicionar despesas a partir do relatório: só as avulsas próprias que podem entrar
 * (mesma regra do "Adicionar a relatório" da tela Despesas).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { Expense } from '@/hooks/useExpenses';

const addMany = vi.hoisted(() => vi.fn());
const rows = vi.hoisted(() => ({ value: [] as Partial<Expense>[] }));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'me' } }) }));
vi.mock('@/hooks/useExpenses', () => ({ useExpenses: () => ({ data: rows.value, isLoading: false }) }));
vi.mock('@/hooks/useReports', () => ({ useAddExpensesToReport: () => ({ mutateAsync: addMany, isPending: false }) }));

import { AddExpensesToReportDialog } from '@/components/reports/AddExpensesToReportDialog';

const e = (over: Partial<Expense>) =>
  ({ id: 'x', user_id: 'me', status: 'draft', report: null, late_decision: null, date: '2026-11-10', description: 'D', amount_cents: 1000, currency: 'BRL', ...over }) as Expense;

const renderDialog = (onOpenChange = vi.fn()) =>
  render(<AddExpensesToReportDialog reportId="r1" reportTitle="Relatório Nov 2026" open onOpenChange={onOpenChange} />);

describe('Adicionar despesas no relatório', () => {
  beforeEach(() => {
    addMany.mockReset().mockResolvedValue(undefined);
    rows.value = [
      e({ id: 'a1', description: 'Almoço' }),
      e({ id: 'a2', description: 'Uber', amount_cents: 2550 }),
      e({ id: 'c1', description: 'Do colega', user_id: 'other' }),
      e({ id: 'p1', description: 'Pendente do gestor', late_decision: 'pending' }),
      e({ id: 's1', description: 'Enviada', status: 'submitted' }),
    ];
  });
  afterEach(() => cleanup());

  it('lista só as avulsas próprias que podem entrar', () => {
    renderDialog();
    expect(screen.getByLabelText('Adicionar Almoço')).toBeInTheDocument();
    expect(screen.getByLabelText('Adicionar Uber')).toBeInTheDocument();
    expect(screen.queryByLabelText('Adicionar Do colega')).toBeNull();
    expect(screen.queryByLabelText('Adicionar Pendente do gestor')).toBeNull();
    expect(screen.queryByLabelText('Adicionar Enviada')).toBeNull();
  });

  it('selecionar todas e adicionar manda os ids ao relatório e fecha', async () => {
    const onOpenChange = vi.fn();
    renderDialog(onOpenChange);
    fireEvent.click(screen.getByText('Selecionar todas (2)'));
    expect(screen.getByTestId('add-expenses-confirm')).toHaveTextContent('Adicionar 2 (R$');
    fireEvent.click(screen.getByTestId('add-expenses-confirm'));
    await waitFor(() => expect(addMany).toHaveBeenCalledWith({ reportId: 'r1', expenseIds: ['a1', 'a2'] }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('sem avulsas explica que despesa nova do ciclo já entra sozinha', () => {
    rows.value = [];
    renderDialog();
    expect(screen.getByTestId('no-loose-expenses')).toHaveTextContent(/já entra neste relatório sozinha/);
    expect(screen.getByTestId('add-expenses-confirm')).toBeDisabled();
  });
});
