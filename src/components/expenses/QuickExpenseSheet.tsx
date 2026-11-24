/**
 * Sprint 6 — Camera-first quick expense capture.
 * Onda 3a — passou a lançar pela RPC create_expense_in_current_report (motor de
 * política): a despesa é validada (teto de alimentação, exceção de evento) e
 * vinculada ao relatório do ciclo via report_items — antes ficava avulsa.
 *
 * Fluxo:
 * 1. `capture` — "Tirar foto" (câmera no celular) ou "Escolher da galeria", que
 *    aceita várias notas: viram uma fila, lançada uma por vez ("nota 2 de 7"),
 *    com a próxima já sendo lida enquanto a pessoa confere a atual.
 * 2. `review` — preview + OCR via `useValidateReceipt`. User escolhe categoria e
 *    salva, ou vai pra `edit` pra refinar.
 * 3. `edit` — form (descrição, valor, data, categoria, evento).
 *
 * Leitura duvidosa (valor/data com confiança média ou baixa, foto tremida, nota
 * cortada...) não salva pelo atalho: vai para `edit` com os campos destacados.
 *
 * HEIC é convertido pra JPEG via `convertHeicToJpeg` antes do preview/OCR.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CalendarIcon, Camera, Images, Loader2, RotateCcw, PartyPopper, SkipForward } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import { useCreateExpenseInReport, type CreateExpenseInReportResult } from '@/hooks/useCurrentReport';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { attachReceipt, receiptFileProblem, receiptHash } from '@/lib/receipts';
import { useExpensePolicy } from '@/hooks/usePolicy';
import { useActiveExpenseTypes } from '@/hooks/useExpenseTypes';
import { groupBySector } from '@/lib/categoryGroups';
import { useValidateReceipt, receiptPolicyBlocks, receiptDateNotice, prefetchReceiptReading } from '@/hooks/useValidateReceipt';
import { receiptDateInWindow } from '@/lib/receiptDate';
import { convertHeicToJpeg } from '@/lib/convertHeic';
import { formatCurrency, parseAmountToCents, amountFieldError, endOfToday, minExpenseDate, foodCapCents, foodCapLabel, formatAmountInput } from '@/lib/constants';
import { useFoodCapAmount } from '@/hooks/useFoodCapAmount';
import { FoodCapHint } from './FoodCapHint';
import { O2Rings } from '@/components/brand/O2Rings';
import { READ_WARN_BOX, READ_WARN_FIELD, READ_WARN_TEXT } from './readingWarning';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
// Lote da galeria: acima disso a fila cansa e a cota de leituras (60/h) aperta.
export const MAX_BATCH_FILES = 20;

export type QuickExpenseStep = 'capture' | 'review' | 'edit';

export interface QuickExpenseSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Callback após criar despesa (pra refresh local). */
  onCreated?: () => void;
  /** Permite override do step inicial nos testes. */
  initialStep?: QuickExpenseStep;
}

const formSchema = z.object({
  date: z.date({ required_error: 'Selecione uma data' }),
  // Opcional: vazia vira estabelecimento ou categoria. Obrigatória só para nota de
  // alimentação de vários dias (checado no submit, que conhece a categoria).
  description: z.string().trim().max(200, 'Até 200 caracteres'),
  amount: z
    .string()
    .min(1, 'Valor é obrigatório')
    .refine((v) => !amountFieldError(v), (v) => ({ message: amountFieldError(v) ?? '' })),
});

type FormData = z.infer<typeof formSchema>;




function centsToInput(cents: number | null): string {
  if (cents == null) return '';
  return (cents / 100).toFixed(2).replace('.', ',');
}

export function QuickExpenseSheet({
  open,
  onOpenChange,
  onCreated,
  initialStep = 'capture',
}: QuickExpenseSheetProps) {
  const isMobile = useIsMobile();
  const inputRef = useRef<HTMLInputElement>(null);
  // Galeria: input sem `capture` e com `multiple` — nota do WhatsApp, várias de uma vez.
  const galleryRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<QuickExpenseStep>(initialStep);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [isConverting, setIsConverting] = useState(false);
  // Lote: notas que faltam (a atual não entra), total escolhido e quantas foram lançadas.
  const [queue, setQueue] = useState<File[]>([]);
  const [batchTotal, setBatchTotal] = useState(0);
  const [savedCount, setSavedCount] = useState(0);
  const preparedRef = useRef(new WeakSet<File>());
  const [categoryId, setCategoryId] = useState<string>('');
  const [isEvent, setIsEvent] = useState(false);
  // Justificativa obrigatória quando a despesa é marcada como evento (foge do teto).
  const [eventNote, setEventNote] = useState('');
  // Dias que uma nota de alimentação cobre (marmitas do mês > 1). Teto = dias × limite diário.
  const [foodDays, setFoodDays] = useState('1');
  // Flash verde discreto quando o OCR entrega os dados (visual apenas).
  const [dataFlash, setDataFlash] = useState(false);

  const validation = useValidateReceipt();
  const createExpense = useCreateExpenseInReport();
  const { data: policy } = useExpensePolicy();
  const foodDailyLimit = (policy as { food_daily_limit_cents?: number | null } | undefined)?.food_daily_limit_cents ?? 3000;
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const { data: categories = [] } = useActiveExpenseTypes();

  const grouped = useMemo(() => groupBySector(categories), [categories]);
  const selectedCategory = categories.find((c) => c.id === categoryId);
  const isFood = selectedCategory?.kind === 'food';

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      date: new Date(),
      description: '',
      amount: '',
    },
  });

  // Alimentação (sem evento): o campo Valor é o lançado, até dias × teto diário.
  const foodDaysNum = Math.min(31, Math.max(1, parseInt(foodDays, 10) || 1));
  const capActive = isFood && !isEvent;
  const foodCap = useFoodCapAmount({
    active: capActive,
    dailyLimitCents: foodDailyLimit,
    days: foodDaysNum,
    setAmount: (v) => form.setValue('amount', v, { shouldValidate: true }),
  });
  const watchedAmount = form.watch('amount');
  /** Valor lançado a partir do valor da nota lido no comprovante. */
  const launchedFromNote = (noteCents: number) =>
    capActive ? foodCapCents(noteCents, foodDailyLimit, foodDaysNum) : noteCents;

  // Reset state quando o sheet abre/fecha.
  useEffect(() => {
    if (!open) {
      if (queue.length > 0) {
        const n = queue.length;
        toast.info(n === 1 ? '1 nota ficou sem lançar.' : `${n} notas ficaram sem lançar.`);
      }
      setStep(initialStep);
      setFile(null);
      setPreview(null);
      setCategoryId('');
      setIsEvent(false);
      setEventNote('');
      setFoodDays('1');
      setQueue([]);
      setBatchTotal(0);
      setSavedCount(0);
      validation.reset();
      form.reset({ date: new Date(), description: '', amount: '' });
      foodCap.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** Converte (HEIC) e confere a foto. Devolve o arquivo pronto ou null com o motivo no toast. */
  const prepareFile = async (selected: File, quiet = false): Promise<File | null> => {
    const name = batchTotal > 1 ? ` (${selected.name})` : '';
    if (selected.size > MAX_FILE_SIZE) {
      if (!quiet) toast.error(`Foto muito grande (>10MB)${name}. Tente reduzir a resolução.`);
      return null;
    }
    let processed = selected;
    try {
      processed = await convertHeicToJpeg(selected);
    } catch (err) {
      console.error('HEIC conversion failed:', err);
      if (!quiet) toast.error(`Não foi possível converter a imagem${name}. Tente outro formato.`);
      return null;
    }
    const problem = await receiptFileProblem(processed);
    if (problem) {
      if (!quiet) toast.error(name ? `${problem}${name}` : problem);
      return null;
    }
    return processed;
  };

  // Lote: enquanto a pessoa confere a nota atual, a próxima já é convertida e lida.
  useEffect(() => {
    const next = queue[0];
    if (step === 'capture' || !next || preparedRef.current.has(next)) return;
    preparedRef.current.add(next);
    let cancelled = false;
    void prepareFile(next, true).then((processed) => {
      if (!processed || cancelled) return;
      preparedRef.current.add(processed);
      prefetchReceiptReading(processed);
      setQueue((q) => (q[0] === next ? [processed, ...q.slice(1)] : q));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, step]);

  const handleFileSelected = async (selected: File | null): Promise<boolean> => {
    if (!selected) return false;

    setIsConverting(true);
    const processed = await prepareFile(selected);
    setIsConverting(false);
    if (!processed) return false;

    setFile(processed);

    // gera preview
    const reader = new FileReader();
    reader.onloadend = () => setPreview(reader.result as string);
    reader.readAsDataURL(processed);

    // dispara OCR — passa data/valor "vazios" só pra extrair valores
    // sem flagar divergência. Como o form ainda não tem valor, validate
    // sempre vai marcar warning/divergence; isso está OK aqui — usamos
    // só o `result.extracted_*` como sugestão.
    const today = format(new Date(), 'yyyy-MM-dd');
    validation.validate(processed, today, 0);

    setStep('review');
    return true;
  };

  /** Galeria: uma foto segue o fluxo normal; várias viram fila. */
  const handleGalleryFiles = async (picked: File[]) => {
    if (picked.length === 0) return;
    let files = picked;
    if (files.length > MAX_BATCH_FILES) {
      toast.warning(`Dá para lançar até ${MAX_BATCH_FILES} notas por vez. Seguem as primeiras ${MAX_BATCH_FILES}.`);
      files = files.slice(0, MAX_BATCH_FILES);
    }
    setBatchTotal(files.length);
    setSavedCount(0);
    await startFrom(files);
  };

  /** Abre a primeira nota que der para ler; as que não abrem são puladas com aviso. */
  const startFrom = async (files: File[]) => {
    let rest = files;
    while (rest.length > 0) {
      const [current, ...others] = rest;
      setQueue(others);
      if (await handleFileSelected(current)) return true;
      rest = others;
    }
    setQueue([]);
    return false;
  };

  /** Fecha a nota atual (lançada ou pulada) e abre a próxima do lote, se houver. */
  const finishCurrent = async (saved: boolean) => {
    const done = savedCount + (saved ? 1 : 0);
    if (saved) {
      setSavedCount(done);
      onCreated?.();
    }
    if (queue.length > 0) {
      setFile(null);
      setPreview(null);
      validation.reset();
      setIsEvent(false);
      setEventNote('');
      setFoodDays('1');
      form.reset({ date: new Date(), description: '', amount: '' });
      foodCap.reset();
      // A categoria fica: num lote ela costuma ser a mesma (ex.: refeições do mês).
      if (await startFrom(queue)) return;
    }
    if (batchTotal > 1) {
      toast.success(done === 1 ? '1 despesa lançada.' : `${done} despesas lançadas.`);
    }
    onOpenChange(false);
  };

  const handleRetake = () => {
    setFile(null);
    setPreview(null);
    validation.reset();
    setStep('capture');
  };

  const inBatch = batchTotal > 1;
  const batchPosition = batchTotal - queue.length;
  const skipButton = (
    <Button
      type="button"
      variant="ghost"
      onClick={() => void finishCurrent(false)}
      disabled={createExpense.isPending}
      className="h-10 gap-2"
      data-testid="skip-note-btn"
    >
      <SkipForward className="h-4 w-4" />
      {queue.length > 0 ? 'Pular esta nota' : 'Pular e terminar'}
    </Button>
  );

  // A despesa já existe quando isto roda; se o upload falhar, ela fica sem anexo e
  // o usuário precisa saber — não pode parecer que o comprovante foi junto.
  const saveReceipt = async (result: CreateExpenseInReportResult) => {
    if (!file || !profile?.org_id || !result?.expense?.id) return;
    try {
      await attachReceipt({
        file,
        orgId: profile.org_id,
        userId: profile.id,
        reportId: result.report?.id,
        expenseId: result.expense.id,
        receiptDate: validation.result?.extracted_date ?? null,
      });
      queryClient.invalidateQueries({ queryKey: ['expenses'] });
    } catch (err) {
      console.error('receipt upload failed', err);
      toast.error('Despesa salva, mas o comprovante não subiu. Anexe de novo em Despesas › Ver detalhes.');
    }
  };

  const handleQuickSave = async () => {
    if (!file) return;
    if (!categoryId) {
      toast.error('Escolha a categoria da despesa.');
      return;
    }
    if (isEvent && eventNote.trim().length < 3) {
      toast.error('Descreva o motivo da exceção de evento na observação.');
      return;
    }
    const extracted = validation.result;
    const finalDate = expenseDateFromReading(extracted?.extracted_date);
    const blocks = receiptPolicyBlocks(validation.result);
    if (blocks.length > 0) {
      toast.error(blocks[0]);
      return;
    }
    if (validation.review.notAReceipt) {
      toast.warning('Isso não parece um comprovante. Tire outra foto ou preencha os dados à mão.');
      goToEdit();
      return;
    }
    // Sem valor lido do cupom não há "salvar rápido": salvar R$ 0,00 em silêncio era
    // o que acontecia. Leva para o formulário com o foco no valor.
    if (!extracted?.extracted_amount_cents || extracted.extracted_amount_cents <= 0) {
      toast.error('Não consegui ler o valor do comprovante — confira os dados.');
      goToEdit();
      return;
    }
    // Leitura duvidosa não vira despesa sem a pessoa olhar: valor errado salvo pelo
    // atalho só aparece para o aprovador, que devolve o relatório inteiro.
    if (validation.review.amount || validation.review.date) {
      toast.warning('Leitura com dúvida — confira o valor e a data antes de salvar.');
      goToEdit();
      return;
    }
    const multiDay = isFood && !isEvent && (parseInt(foodDays, 10) || 1) > 1;
    if (multiDay) {
      toast.error('Nota de vários dias: descreva as refeições em "Editar detalhes".');
      goToEdit();
      return;
    }
    const description = autoDescription(extracted?.extracted_supplier, selectedCategory?.name, extracted?.extracted_date);

    try {
      const result = await createExpense.mutateAsync({
        date: finalDate,
        description,
        // Alimentação: o lançado (nota limitada ao teto), o mesmo que a tela mostra.
        amount_cents: launchedFromNote(extracted.extracted_amount_cents),
        category_id: categoryId,
        is_event: isEvent,
        food_days: isFood && !isEvent ? Math.min(31, Math.max(1, parseInt(foodDays, 10) || 1)) : 1,
        notes: isEvent ? eventNote.trim() : undefined,
        payment_method: 'personal_card',
        is_reimbursable: true,
        receipt_hash: file ? await receiptHash(file) : null,
      });
      await saveReceipt(result);
      await finishCurrent(true);
    } catch (err) {
      // toast já vem do useCreateExpenseInReport.onError
      console.error('quick save failed', err);
    }
  };

  const handleEditSubmit = async (data: FormData) => {
    if (!categoryId) {
      toast.error('Escolha a categoria da despesa.');
      return;
    }
    if (isEvent && eventNote.trim().length < 3) {
      toast.error('Descreva o motivo da exceção de evento na observação.');
      return;
    }
    if (isFood && !isEvent && (parseInt(foodDays, 10) || 1) > 1 && data.description.trim().length < 3) {
      form.setError('description', { message: 'Descreva as refeições (ex.: 20 marmitas do mês).' });
      return;
    }
    const blocks = receiptPolicyBlocks(validation.result);
    if (blocks.length > 0) {
      toast.error(blocks[0]);
      return;
    }
    try {
      const result = await createExpense.mutateAsync({
        date: format(data.date, 'yyyy-MM-dd'),
        description:
          data.description.trim() ||
          autoDescription(validation.result?.extracted_supplier, selectedCategory?.name, format(data.date, 'yyyy-MM-dd')),
        amount_cents: parseAmountToCents(data.amount),
        category_id: categoryId,
        is_event: isEvent,
        food_days: isFood && !isEvent ? Math.min(31, Math.max(1, parseInt(foodDays, 10) || 1)) : 1,
        notes: isEvent ? eventNote.trim() : undefined,
        payment_method: 'personal_card',
        is_reimbursable: true,
        receipt_hash: file ? await receiptHash(file) : null,
      });
      await saveReceipt(result);
      await finishCurrent(true);
    } catch (err) {
      console.error('edit submit failed', err);
    }
  };

  // Quando entra em edit, pré-popular form com dados extraídos.
  const goToEdit = () => {
    const extracted = validation.result;
    form.reset({
      // Nota fora da janela de lançamento: a despesa fica com hoje (o banco recusaria).
      date: new Date(expenseDateFromReading(extracted?.extracted_date) + 'T00:00:00'),
      description: '',
      amount: centsToInput(extracted?.extracted_amount_cents ?? null),
    });
    foodCap.reset();
    // Nota lida → campo com o lançado (até o teto, se alimentação).
    foodCap.applyNote(extracted?.extracted_amount_cents);
    setStep('edit');
  };

  const extractedSummary = useMemo(() => {
    const r = validation.result;
    if (!r) return null;
    return {
      date: r.extracted_date,
      amount: r.extracted_amount_cents,
      confidence: r.confidence,
    };
  }, [validation.result]);

  // Ao assentar em success/warning, dispara um flash verde de "capturado".
  useEffect(() => {
    if (validation.status === 'success' || validation.status === 'warning') {
      setDataFlash(true);
      const t = setTimeout(() => setDataFlash(false), 700);
      return () => clearTimeout(t);
    }
  }, [validation.status]);

  const isSaving = createExpense.isPending;

  // Data da nota ≠ data da despesa: só avisa (o gestor vê o selo na revisão).
  const watchedDate = form.watch('date');
  const dateNotice = receiptDateNotice(
    validation.result,
    step === 'edit' && watchedDate
      ? format(watchedDate, 'yyyy-MM-dd')
      : expenseDateFromReading(validation.result?.extracted_date),
  );
  const dateNoticeBox = dateNotice && (
    <p className={READ_WARN_BOX} data-testid="receipt-date-notice">
      {dateNotice}
    </p>
  );

  // Destaque some quando a pessoa mexe no campo (o form nasce com o valor lido).
  const { dirtyFields } = form.formState;
  const flagAmount = !!file && validation.review.amount && !dirtyFields.amount;
  const flagDate = !!file && validation.review.date && !dirtyFields.date;

  // Bloco reutilizável: categoria + toggle de evento.
  const categoryAndEvent = (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="quick-category" className="o2-eyebrow">Categoria</Label>
        <Select value={categoryId} onValueChange={setCategoryId}>
          <SelectTrigger id="quick-category" className="h-12" data-testid="quick-category-select">
            <SelectValue placeholder="Escolha a categoria" />
          </SelectTrigger>
          <SelectContent>
            {grouped.map((g) => (
              <SelectGroup key={g.sector}>
                <SelectLabel>{g.sector}</SelectLabel>
                {g.items.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>
      {isFood && !isEvent && (
        <div className="space-y-1.5">
          <Label htmlFor="quick-food-days" className="o2-eyebrow">Dias cobertos pela nota</Label>
          <Input
            id="quick-food-days"
            type="number"
            inputMode="numeric"
            min={1}
            max={31}
            value={foodDays}
            onChange={(e) => setFoodDays(e.target.value)}
            className="h-11 w-28"
          />
          <p className="text-xs text-muted-foreground">
            1 = refeição do dia. Marmitas ou compra para vários dias: quantos dias a nota cobre.
          </p>
        </div>
      )}

      <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
        <div className="space-y-0.5">
          <Label htmlFor="quick-event" className="flex items-center gap-1.5">
            <PartyPopper className="h-4 w-4 text-muted-foreground" />
            Evento
          </Label>
          <p className="text-xs text-muted-foreground">
            {isFood
              ? `Libera o teto de ${formatCurrency(foodDailyLimit)}/dia. Vai para revisão do aprovador.`
              : 'Refeição/despesa de evento aprovado pela Diretoria.'}
          </p>
        </div>
        <Switch
          id="quick-event"
          checked={isEvent}
          onCheckedChange={setIsEvent}
          data-testid="quick-event-switch"
        />
      </div>

      {isEvent && (
        <div className="space-y-1.5">
          <Label htmlFor="quick-event-note">
            Motivo da exceção <span className="text-destructive">*</span>
          </Label>
          <Textarea
            id="quick-event-note"
            value={eventNote}
            onChange={(e) => setEventNote(e.target.value)}
            placeholder="Descreva por que essa despesa foge do combinado..."
            className="min-h-[72px]"
            data-testid="quick-event-note"
          />
          <p className="text-xs text-muted-foreground">
            Obrigatório para lançar como evento.
          </p>
        </div>
      )}
    </div>
  );

  const content = (
    <div className="px-4 pb-6 space-y-4 overflow-y-auto" data-testid="quick-expense-content">
      {/* Hidden input — sempre montado pra o ref ficar disponível. */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture={isMobile ? 'environment' : undefined}
        hidden
        data-testid="quick-expense-file-input"
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          handleFileSelected(f);
          // Reset input pra permitir re-selecionar mesma foto.
          e.target.value = '';
        }}
      />
      <input
        ref={galleryRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        data-testid="quick-expense-gallery-input"
        onChange={(e) => {
          void handleGalleryFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />

      {step === 'capture' && (
        <div
          // Celular: compacto para os três botões caberem sem rolar.
          className="flex flex-col items-center justify-center py-4 sm:py-12 gap-3 sm:gap-4"
          data-testid="step-capture"
        >
          {isConverting ? (
            <>
              <O2Rings size={56} spinning fast />
              <p className="o2-eyebrow">Preparando foto...</p>
            </>
          ) : (
            <>
              <Camera className="h-8 w-8 sm:h-12 sm:w-12 text-muted-foreground" />
              <p className="text-sm text-muted-foreground text-center max-w-xs">
                Fotografe a nota agora ou escolha fotos que você já tem. Dá para escolher várias notas de uma vez.
              </p>
              <div className="flex w-full max-w-xs flex-col gap-2">
                {isMobile && (
                  <Button
                    onClick={() => inputRef.current?.click()}
                    className="h-12 gap-2"
                    data-testid="open-camera-btn"
                  >
                    <Camera className="h-5 w-5" />
                    Tirar foto
                  </Button>
                )}
                <Button
                  variant={isMobile ? 'outline' : 'default'}
                  onClick={() => galleryRef.current?.click()}
                  className="h-12 gap-2"
                  data-testid="open-gallery-btn"
                >
                  <Images className="h-5 w-5" />
                  {isMobile ? 'Escolher da galeria' : 'Selecionar fotos'}
                </Button>
                <Button type="button" variant="ghost" className="h-11" onClick={goToEdit}>
                  Digitar sem foto
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {step === 'review' && (
        <div className="space-y-4" data-testid="step-review">
          {preview && (
            <div className="relative rounded-lg overflow-hidden border bg-muted/30">
              <img
                src={preview}
                alt="Preview da nota fiscal"
                // Celular: foto menor para valor, categoria e Salvar caberem sem rolar.
                className="w-full max-h-32 sm:max-h-64 object-contain"
              />
              {/* Linha de scan verde varrendo o comprovante durante o OCR. */}
              {validation.status === 'validating' && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0"
                  style={{ animation: 'o2-scan 1.2s cubic-bezier(0.4,0,0.2,1) infinite' }}
                >
                  <div className="h-0.5 w-full bg-primary shadow-[0_0_12px_2px_hsl(var(--primary)/0.7)]" />
                </div>
              )}
            </div>
          )}

          <div
            className={cn(
              'rounded-lg border p-3 space-y-2 bg-muted/20 transition-shadow duration-500',
              dataFlash && 'ring-1 ring-primary/60',
            )}
          >
            <p className="o2-eyebrow">Dados detectados</p>
            {validation.status === 'validating' || isConverting ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="o2-eyebrow">Analisando comprovante...</span>
              </div>
            ) : validation.review.notAReceipt ? (
              <p className={cn(READ_WARN_BOX, 'font-medium')} data-testid="not-a-receipt-warning">
                Isso não parece um comprovante. Tire outra foto da nota ou preencha os dados à mão.
              </p>
            ) : extractedSummary ? (
              <div className="space-y-1.5 text-sm">
                {validation.review.messages.length > 0 && (
                  <ul className={cn(READ_WARN_BOX, 'space-y-0.5')} data-testid="reading-issues">
                    {validation.review.messages.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                )}
                <div className="flex items-baseline justify-between gap-2">
                  <span className="o2-eyebrow">Valor</span>
                  <span className={cn('o2-num font-medium', validation.review.amount && 'text-[hsl(var(--status-event))]')}>
                    {extractedSummary.amount != null
                      ? formatCurrency(launchedFromNote(extractedSummary.amount))
                      : 'não detectado'}
                  </span>
                </div>
                {capActive &&
                  extractedSummary.amount != null &&
                  launchedFromNote(extractedSummary.amount) < extractedSummary.amount && (
                    <p className="text-xs text-muted-foreground text-right" data-testid="food-cap-note">
                      Nota: <span className="o2-num">{formatCurrency(extractedSummary.amount)}</span> · lançado até o
                      teto de {foodCapLabel(foodDailyLimit, foodDaysNum)}. Você pode alterar em "Editar detalhes".
                    </p>
                  )}
                <div className="flex items-baseline justify-between gap-2">
                  <span className="o2-eyebrow">Data</span>
                  <span className={cn('o2-num font-medium', validation.review.date && 'text-[hsl(var(--status-event))]')}>
                    {!extractedSummary.date
                      ? 'não detectada'
                      : receiptDateInWindow(extractedSummary.date)
                      ? format(new Date(extractedSummary.date + 'T00:00:00'), 'dd/MM/yyyy', { locale: ptBR })
                      : // Fora da janela a despesa entra com hoje: mostra o que vai ser salvo, e a nota ao lado.
                        `Hoje · nota de ${format(new Date(extractedSummary.date + 'T00:00:00'), 'dd/MM', { locale: ptBR })}`}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="o2-eyebrow">Confiança</span>
                  {/* Campo em dúvida manda: "Alta" ao lado de um valor em amarelo confundia. */}
                  {validation.review.amount || validation.review.date ? (
                    <span className="font-mono text-sm font-medium text-[hsl(var(--status-event))]">Conferir</span>
                  ) : (
                    <span className="font-mono text-sm font-medium">
                      {CONFIDENCE_LABELS[String(extractedSummary.confidence).toLowerCase()] ??
                        extractedSummary.confidence}
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {validation.errorMessage ||
                  'Não foi possível extrair dados automaticamente.'}
              </p>
            )}
          </div>

          {dateNoticeBox}

          {categoryAndEvent}

          <div className="flex flex-col gap-2">
            <Button
              onClick={handleQuickSave}
              disabled={
                isSaving ||
                // Sem foto o salvar rápido não tem o que salvar (handleQuickSave sai calado).
                !file ||
                validation.status === 'validating' ||
                !categoryId ||
                (isEvent && eventNote.trim().length < 3)
              }
              className="h-12"
              data-testid="quick-save-btn"
            >
              {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {inBatch && queue.length > 0 ? 'Salvar e ir para a próxima' : 'Salvar despesa'}
            </Button>
            <Button
              variant="outline"
              onClick={goToEdit}
              disabled={isSaving}
              className="h-12"
              data-testid="edit-details-btn"
            >
              Editar detalhes
            </Button>
            {inBatch ? (
              skipButton
            ) : (
              <Button
                variant="ghost"
                onClick={handleRetake}
                disabled={isSaving}
                className="h-10 gap-2"
                data-testid="retake-btn"
              >
                <RotateCcw className="h-4 w-4" />
                Tirar outra foto
              </Button>
            )}
          </div>
        </div>
      )}

      {step === 'edit' && (
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleEditSubmit)}
            className="space-y-4"
            data-testid="step-edit"
          >
            {preview && (
              <div className="rounded-lg overflow-hidden border bg-muted/30">
                <img
                  src={preview}
                  alt="Preview da nota fiscal"
                  className="w-full max-h-32 object-contain"
                />
              </div>
            )}

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Descrição <span className="font-normal text-muted-foreground">(opcional, exceto nota de vários dias)</span></FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Ex: Almoço com cliente"
                      className="h-12"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Valor (R$)</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="0,00"
                        className={cn('h-12', flagAmount && READ_WARN_FIELD)}
                        inputMode="decimal"
                        data-testid="quick-amount-input"
                        {...field}
                        // Mostra como o valor foi lido ("1.500" → "1.500,00") antes de salvar.
                        onBlur={() => {
                          const formatted = formatAmountInput(field.value);
                          field.onChange(formatted);
                          foodCap.onAmountBlur(formatted);
                          field.onBlur();
                        }}
                      />
                    </FormControl>
                    {flagAmount && <p className={READ_WARN_TEXT}>Confira o valor lido</p>}
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="date"
                render={({ field }) => (
                  <FormItem className="flex flex-col">
                    <FormLabel>Data</FormLabel>
                    <Popover>
                      <PopoverTrigger asChild>
                        <FormControl>
                          <Button
                            variant="outline"
                            data-testid="quick-date-btn"
                            className={cn(
                              'h-12 pl-3 text-left font-normal',
                              !field.value && 'text-muted-foreground',
                              flagDate && READ_WARN_FIELD,
                            )}
                          >
                            {field.value ? (
                              format(field.value, 'dd/MM/yyyy', { locale: ptBR })
                            ) : (
                              <span>Selecione</span>
                            )}
                            <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                          </Button>
                        </FormControl>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar
                          mode="single"
                          selected={field.value}
                          onSelect={field.onChange}
                          disabled={(d) => d > endOfToday() || d < minExpenseDate(policy?.cycle_cutoff_day)}
                          initialFocus
                          className="pointer-events-auto"
                        />
                      </PopoverContent>
                    </Popover>
                    {flagDate && <p className={READ_WARN_TEXT}>Confira a data lida</p>}
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="col-span-2 -mt-1 space-y-0.5 empty:hidden">
                <FoodCapHint cap={foodCap} amount={watchedAmount} />
              </div>
            </div>

            {dateNoticeBox}

            {categoryAndEvent}

            <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                // Sem foto não há review: voltar para lá mostrava um "Salvar" que não salvava.
                onClick={() => setStep(file ? 'review' : 'capture')}
                disabled={isSaving}
                className="h-12"
              >
                Voltar
              </Button>
              <Button type="submit" disabled={isSaving} className="h-12">
                {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Salvar
              </Button>
            </div>
            {inBatch && <div className="flex justify-center">{skipButton}</div>}
          </form>
        </Form>
      )}
    </div>
  );

  const baseTitle =
    step === 'capture'
      ? 'Nova despesa'
      : step === 'review'
      ? 'Revisar despesa'
      : 'Editar detalhes';
  const title = inBatch && step !== 'capture' ? `${baseTitle} · nota ${batchPosition} de ${batchTotal}` : baseTitle;

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="max-h-[90vh]">
          <DrawerHeader>
            <DrawerTitle>{title}</DrawerTitle>
          </DrawerHeader>
          {content}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {content}
      </DialogContent>
    </Dialog>
  );
}

/** Data da despesa a partir da nota: a da nota se estiver na janela de lançamento, senão hoje. */
function expenseDateFromReading(extracted?: string | null): string {
  return extracted && receiptDateInWindow(extracted) ? extracted : format(new Date(), 'yyyy-MM-dd');
}

/** Descrição quando a pessoa não escreve: estabelecimento da nota, senão categoria + data. */
function autoDescription(supplier?: string | null, category?: string | null, date?: string | null): string {
  if (supplier?.trim()) return supplier.trim().slice(0, 200);
  const dia = date ? ` ${date.slice(8, 10)}/${date.slice(5, 7)}` : '';
  return `${category ?? 'Despesa'}${dia}`;
}

const CONFIDENCE_LABELS: Record<string, string> = { high: 'Alta', medium: 'Média', low: 'Baixa' };
