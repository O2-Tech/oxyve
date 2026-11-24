/**
 * Adicionar despesas a partir do relatório: lista as avulsas da pessoa (rascunho
 * próprio, fora de relatório, sem decisão pendente do gestor — as mesmas regras do
 * "Adicionar a relatório" da tela Despesas) e põe as marcadas neste relatório.
 */
import { useEffect, useMemo, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useAuth } from '@/contexts/AuthContext';
import { useExpenses } from '@/hooks/useExpenses';
import { useAddExpensesToReport } from '@/hooks/useReports';
import { canAddExpenseToReport } from '@/components/expenses/expenseActions';
import { formatCurrency } from '@/lib/constants';

interface AddExpensesToReportDialogProps {
  reportId: string;
  reportTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddExpensesToReportDialog({ reportId, reportTitle, open, onOpenChange }: AddExpensesToReportDialogProps) {
  const { user } = useAuth();
  const { data: expenses, isLoading } = useExpenses({ tab: 'loose' });
  const addExpenses = useAddExpensesToReport();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Gestor enxerga as despesas da empresa: aqui só entram as próprias.
  const loose = useMemo(
    () => (expenses ?? []).filter((e) => canAddExpenseToReport(e, user?.id)),
    [expenses, user?.id],
  );
  const allSelected = loose.length > 0 && loose.every((e) => selected.has(e.id));
  const totalCents = loose.filter((e) => selected.has(e.id)).reduce((sum, e) => sum + e.amount_cents, 0);

  useEffect(() => {
    if (!open) setSelected(new Set());
  }, [open]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const handleAdd = async () => {
    const ids = loose.filter((e) => selected.has(e.id)).map((e) => e.id);
    if (ids.length === 0) return;
    try {
      await addExpenses.mutateAsync({ reportId, expenseIds: ids });
      onOpenChange(false);
    } catch {
      // toast vem do hook
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Adicionar despesas</DialogTitle>
          <DialogDescription>
            Despesas avulsas suas (fora de relatório) que podem entrar em "{reportTitle}".
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : loose.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground" data-testid="no-loose-expenses">
            Você não tem despesas avulsas. Despesa nova lançada com data deste ciclo já entra neste relatório sozinha.
          </p>
        ) : (
          <div className="flex min-h-0 flex-col gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-11 self-start px-2"
              onClick={() => setSelected(allSelected ? new Set() : new Set(loose.map((e) => e.id)))}
            >
              {allSelected ? 'Desmarcar todas' : `Selecionar todas (${loose.length})`}
            </Button>
            <ul className="min-h-0 space-y-1 overflow-y-auto">
              {loose.map((e) => (
                <li key={e.id}>
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border p-3 hover:bg-muted/40">
                    <Checkbox
                      checked={selected.has(e.id)}
                      onCheckedChange={() => toggle(e.id)}
                      aria-label={`Adicionar ${e.description}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{e.description}</span>
                      <span className="block text-xs text-muted-foreground">
                        {format(parseISO(e.date), "dd 'de' MMM", { locale: ptBR })}
                      </span>
                    </span>
                    <span className="o2-num text-sm">{formatCurrency(e.amount_cents, e.currency ?? undefined)}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" className="h-12" onClick={() => onOpenChange(false)} disabled={addExpenses.isPending}>
            Cancelar
          </Button>
          <Button
            className="h-12"
            onClick={handleAdd}
            disabled={selected.size === 0 || addExpenses.isPending}
            data-testid="add-expenses-confirm"
          >
            {addExpenses.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {selected.size > 0 ? `Adicionar ${selected.size} (${formatCurrency(totalCents)})` : 'Adicionar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
