/**
 * Lançamento por foto no celular, com backend falso (e2e/support/mockSupabase.ts):
 * a tela de captura oferece câmera e galeria, a galeria aceita várias notas e
 * vira uma fila ("nota 1 de 2"), e a nota antiga mostra que entra com a data de hoje.
 *
 * SHOTS=<pasta> guarda um print de cada tela (para revisar o visual no celular).
 */
import { test, expect, devices, type Page } from '@playwright/test';
import { format, subDays } from 'date-fns';
import { mockSupabase } from './support/mockSupabase';

const SHOTS = process.env.SHOTS;

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

const reading = (date: string, amount: number, supplier: string) => ({
  extracted_date: date,
  extracted_amount_cents: amount,
  extracted_cnpj: '11222333000181',
  extracted_supplier: supplier,
  receipt_type: 'nota_fiscal',
  confidence: 'high',
  amount_confidence: 'high',
  date_confidence: 'high',
  issues: [],
  expense_kind_hint: 'food',
  model_used: 'claude-opus-5-5',
});

/** Foto de cupom gerada no próprio navegador: o app confere se a imagem abre. */
async function receiptPhoto(page: Page, title: string): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const other = await page.context().newPage();
  await other.setViewportSize({ width: 360, height: 520 });
  await other.setContent(
    `<div style="font:16px monospace;padding:24px;background:#fff;width:300px">
       <b>${title}</b><br>CNPJ 11.222.333/0001-81<br><br>PRATO DO DIA ..... 28,90<br>
       REFRIGERANTE ....... 6,00<br><br><b>TOTAL R$ 34,90</b></div>`,
  );
  const buffer = await other.screenshot();
  await other.close();
  return { name: `${title}.png`, mimeType: 'image/png', buffer };
}

test.describe('celular', () => {
  test.use({ viewport: devices['iPhone 13'].viewport, isMobile: true, hasTouch: true });

  test('câmera e galeria na captura; várias notas viram fila', async ({ page }) => {
    const hoje = format(new Date(), 'yyyy-MM-dd');
    const respostas = [reading(hoje, 3490, 'Restaurante Bom Prato'), reading(hoje, 2150, 'Padaria Central')];
    let lidas = 0;
    await mockSupabase(page, { functions: () => respostas[Math.min(lidas++, respostas.length - 1)] });
    const fotos = [await receiptPhoto(page, 'Restaurante'), await receiptPhoto(page, 'Padaria')];

    await page.goto('/app/dashboard');
    await page.getByRole('button', { name: 'Capturar despesa por foto' }).click();

    await expect(page.getByTestId('open-camera-btn')).toHaveText('Tirar foto');
    await expect(page.getByTestId('open-gallery-btn')).toHaveText('Escolher da galeria');
    await shot(page, '1-captura');

    await page.getByTestId('quick-expense-gallery-input').setInputFiles(fotos);
    await expect(page.getByText('Revisar despesa · nota 1 de 2')).toBeVisible();
    await expect(page.getByText('R$ 34,90')).toBeVisible();

    await page.getByRole('combobox').first().click();
    await page.getByRole('option', { name: 'Alimentação – Comercial' }).click();
    await shot(page, '2-nota-1-de-2');

    await page.getByTestId('quick-save-btn').click();
    await expect(page.getByText('Revisar despesa · nota 2 de 2')).toBeVisible();
    await expect(page.getByTestId('quick-save-btn')).toHaveText('Salvar despesa');
    await shot(page, '3-nota-2-de-2');

    await page.getByTestId('quick-save-btn').click();
    await expect(page.getByText('2 despesas lançadas.')).toBeVisible();
    await shot(page, '4-fim-do-lote');
  });

  test('nota antiga: a revisão diz que entra com hoje e que o gestor decide', async ({ page }) => {
    const antiga = format(subDays(new Date(), 90), 'yyyy-MM-dd');
    await mockSupabase(page, { functions: () => reading(antiga, 4200, 'Restaurante Bom Prato') });
    const foto = await receiptPhoto(page, 'Antiga');

    await page.goto('/app/dashboard');
    await page.getByRole('button', { name: 'Capturar despesa por foto' }).click();
    await page.getByTestId('quick-expense-gallery-input').setInputFiles([foto]);

    await expect(page.getByText(`Hoje · nota de ${antiga.slice(8, 10)}/${antiga.slice(5, 7)}`)).toBeVisible();
    await expect(page.getByTestId('receipt-date-notice')).toContainText('o gestor vê a data da nota e decide se aprova');
    await shot(page, '5-nota-antiga');

    await page.getByTestId('edit-details-btn').click();
    await expect(page.getByTestId('step-edit')).toBeVisible();
    await shot(page, '6-editar-detalhes');
  });
});
