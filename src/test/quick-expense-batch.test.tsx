/**
 * QuickExpenseSheet — lote da galeria: várias notas viram uma fila lançada uma
 * por vez ("nota 2 de 3"), com a categoria mantida, a próxima nota lida
 * enquanto a pessoa confere a atual e o pular/fechar sem perder a conta.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { format, subDays } from 'date-fns';
import type { ReactNode } from 'react';

const readDate = format(subDays(new Date(), 2), 'yyyy-MM-dd');

const invoke = vi.hoisted(() => vi.fn());
const mutateAsync = vi.hoisted(() => vi.fn());
const toastWarning = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastInfo = vi.hoisted(() => vi.fn());

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: toastSuccess, warning: toastWarning, info: toastInfo }),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { functions: { invoke }, from: vi.fn(), rpc: vi.fn() },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1' }, profile: { id: 'u1', org_id: 'o1' } }),
}));

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

vi.mock('@/hooks/useExpenseTypes', () => ({
  useActiveExpenseTypes: () => ({
    data: [{ id: 'c1', name: 'Estacionamento', kind: 'transport', sector: 'Comercial' }],
  }),
}));

vi.mock('@/hooks/usePolicy', () => ({
  useExpensePolicy: () => ({ data: { food_daily_limit_cents: 3000 } }),
}));

vi.mock('@/hooks/useCurrentReport', () => ({
  useCreateExpenseInReport: () => ({ mutateAsync, isPending: false }),
}));

vi.mock('@/lib/receipts', () => ({
  attachReceipt: vi.fn().mockResolvedValue('path'),
  receiptFileProblem: vi.fn().mockResolvedValue(null),
  receiptHash: vi.fn().mockResolvedValue('hash'),
}));

vi.mock('@/lib/convertHeic', () => ({ convertHeicToJpeg: (f: File) => Promise.resolve(f) }));

vi.mock('@/lib/receiptImage', () => ({
  prepareImageForOcr: () => Promise.resolve({ base64: 'YWJj', mimeType: 'image/jpeg' }),
}));

// Select nativo no lugar do Radix: o teste é sobre a leitura, não sobre o popover.
vi.mock('@/components/ui/select', () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: ReactNode }) => (
    <select data-testid="category-native" value={value} onChange={(e) => onValueChange(e.target.value)}>
      <option value="" />
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectGroup: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectLabel: () => null,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
}));

class FileReaderStub {
  result: string | null = null;
  onload: (() => void) | null = null;
  onloadend: (() => void) | null = null;
  abort() {}
  readAsDataURL() {
    setTimeout(() => {
      this.result = 'data:image/jpeg;base64,YWJj';
      this.onload?.();
      this.onloadend?.();
    }, 0);
  }
}
vi.stubGlobal('FileReader', FileReaderStub);

import { QuickExpenseSheet } from '@/components/expenses/QuickExpenseSheet';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const reliable = {
  extracted_date: readDate,
  extracted_amount_cents: 2500,
  extracted_cnpj: '11222333000181',
  extracted_supplier: 'Estapar',
  receipt_type: 'nota_fiscal',
  confidence: 'high',
  amount_confidence: 'high',
  date_confidence: 'high',
  issues: [],
  expense_kind_hint: 'transport',
  model_used: 'gpt-4o-mini',
};

const nota = (name: string) => new File([name], name, { type: 'image/jpeg' });

async function pickFromGallery(files: File[]) {
  const input = screen.getByTestId('quick-expense-gallery-input') as HTMLInputElement;
  expect(input.multiple).toBe(true);
  await act(async () => {
    fireEvent.change(input, { target: { files } });
  });
  await waitFor(() => expect(screen.getByTestId('step-review')).toBeInTheDocument());
  await waitFor(() => expect(screen.queryByText('Analisando comprovante...')).toBeNull());
}

describe('QuickExpenseSheet — lote da galeria', () => {
  beforeEach(() => {
    invoke.mockReset();
    mutateAsync.mockReset();
    toastWarning.mockReset();
    toastSuccess.mockReset();
    toastInfo.mockReset();
    invoke.mockResolvedValue({ data: reliable, error: null });
    mutateAsync.mockResolvedValue({ expense: { id: 'e1' }, report: { id: 'r1' } });
  });
  afterEach(() => cleanup());

  it('uma foto da galeria segue o fluxo normal, sem contador de lote', async () => {
    render(<QuickExpenseSheet open onOpenChange={() => {}} />, { wrapper });
    await pickFromGallery([nota('a.jpg')]);
    expect(screen.getByText('Revisar despesa')).toBeInTheDocument();
    expect(screen.getByTestId('retake-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('skip-note-btn')).toBeNull();
  });

  it('várias fotos: lança uma por vez, mantém a categoria e avisa o total no fim', async () => {
    const onOpenChange = vi.fn();
    const onCreated = vi.fn();
    render(<QuickExpenseSheet open onOpenChange={onOpenChange} onCreated={onCreated} />, { wrapper });
    await pickFromGallery([nota('a.jpg'), nota('b.jpg')]);

    expect(screen.getByText('Revisar despesa · nota 1 de 2')).toBeInTheDocument();
    expect(screen.queryByTestId('retake-btn')).toBeNull();
    fireEvent.change(screen.getByTestId('category-native'), { target: { value: 'c1' } });
    expect(screen.getByTestId('quick-save-btn')).toHaveTextContent('Salvar e ir para a próxima');

    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-save-btn'));
    });
    await waitFor(() => expect(screen.getByText('Revisar despesa · nota 2 de 2')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText('Analisando comprovante...')).toBeNull());
    expect((screen.getByTestId('category-native') as HTMLSelectElement).value).toBe('c1');
    expect(screen.getByTestId('quick-save-btn')).toHaveTextContent('Salvar despesa');

    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-save-btn'));
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(mutateAsync).toHaveBeenCalledTimes(2);
    expect(onCreated).toHaveBeenCalledTimes(2);
    expect(toastSuccess).toHaveBeenCalledWith('2 despesas lançadas.');
  });

  it('a próxima nota já é lida enquanto a pessoa confere a atual (uma leitura por nota)', async () => {
    render(<QuickExpenseSheet open onOpenChange={() => {}} />, { wrapper });
    await pickFromGallery([nota('a.jpg'), nota('b.jpg')]);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));

    fireEvent.change(screen.getByTestId('category-native'), { target: { value: 'c1' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-save-btn'));
    });
    await waitFor(() => expect(screen.getByText('Revisar despesa · nota 2 de 2')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText('Analisando comprovante...')).toBeNull());
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('pular não lança a nota e segue para a próxima', async () => {
    const onOpenChange = vi.fn();
    render(<QuickExpenseSheet open onOpenChange={onOpenChange} />, { wrapper });
    await pickFromGallery([nota('a.jpg'), nota('b.jpg')]);

    expect(screen.getByTestId('skip-note-btn')).toHaveTextContent('Pular esta nota');
    await act(async () => {
      fireEvent.click(screen.getByTestId('skip-note-btn'));
    });
    await waitFor(() => expect(screen.getByText('Revisar despesa · nota 2 de 2')).toBeInTheDocument());
    expect(screen.getByTestId('skip-note-btn')).toHaveTextContent('Pular e terminar');

    await act(async () => {
      fireEvent.click(screen.getByTestId('skip-note-btn'));
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith('0 despesas lançadas.');
  });

  it('fechar no meio do lote avisa quantas notas ficaram sem lançar', async () => {
    const { rerender } = render(<QuickExpenseSheet open onOpenChange={() => {}} />, { wrapper });
    await pickFromGallery([nota('a.jpg'), nota('b.jpg'), nota('c.jpg')]);
    rerender(<QuickExpenseSheet open={false} onOpenChange={() => {}} />);
    await waitFor(() => expect(toastInfo).toHaveBeenCalledWith('2 notas ficaram sem lançar.'));
  });

  it('mais de 20 fotos: avisa e segue com as 20 primeiras', async () => {
    render(<QuickExpenseSheet open onOpenChange={() => {}} />, { wrapper });
    await pickFromGallery(Array.from({ length: 23 }, (_, i) => nota(`n${i}.jpg`)));
    expect(toastWarning).toHaveBeenCalledWith('Dá para lançar até 20 notas por vez. Seguem as primeiras 20.');
    expect(screen.getByText('Revisar despesa · nota 1 de 20')).toBeInTheDocument();
  });

  it('nota antes da janela: a revisão mostra que entra com hoje e por quê', async () => {
    const old = format(subDays(new Date(), 90), 'yyyy-MM-dd');
    invoke.mockResolvedValue({ data: { ...reliable, extracted_date: old }, error: null });
    render(<QuickExpenseSheet open onOpenChange={() => {}} />, { wrapper });
    await pickFromGallery([nota('a.jpg')]);
    expect(screen.getByText(`Hoje · nota de ${old.slice(8, 10)}/${old.slice(5, 7)}`)).toBeInTheDocument();
    expect(screen.getByTestId('receipt-date-notice')).toHaveTextContent(/o gestor vê a data da nota e decide se aprova/);
  });

  it('fotos já escolhidas (arrastadas na tela Despesas) abrem direto no lote', async () => {
    render(<QuickExpenseSheet open onOpenChange={() => {}} initialFiles={[nota('a.jpg'), nota('b.jpg')]} />, { wrapper });
    await waitFor(() => expect(screen.getByText('Revisar despesa · nota 1 de 2')).toBeInTheDocument());
  });

  it('computador: soltar fotos na área de captura começa o lote', async () => {
    render(<QuickExpenseSheet open onOpenChange={() => {}} />, { wrapper });
    await act(async () => {
      fireEvent.drop(screen.getByTestId('step-capture'), { dataTransfer: { files: [nota('a.jpg'), nota('b.jpg'), nota('c.jpg')] } });
    });
    await waitFor(() => expect(screen.getByText('Revisar despesa · nota 1 de 3')).toBeInTheDocument());
  });
});
