/** CPF da base Pessoas do Pipefy (supabase/functions/_shared/pipefy.ts). Não chama a API. */
import { describe, it, expect } from 'vitest';
import { cpfDosRegistros } from '../../supabase/functions/_shared/pipefy.ts';

const reg = (title: string, cpf: string, emailO2: string | null, pessoal: string | null = null) => ({
  title,
  record_fields: [
    { field: { id: 'cpf' }, value: cpf },
    { field: { id: 'e_mail_o2' }, value: emailO2 },
    { field: { id: 'copy_of_e_mail_o2' }, value: pessoal },
  ],
});

const base = [
  reg('Bia Souza', '123.456.789-09', 'bia@o2inc.com.br'),
  reg('Caio Lima', '98765432100', null, 'caio@gmail.com'),
  reg('Ana Paula', '11144477735', 'ana@o2inc.com.br'),
  reg('Ana Paula', '52998224725', 'ana.p@o2inc.com.br'),
];

describe('cpfDosRegistros', () => {
  it('acha pelo e-mail O2 ou pessoal, sem diferenciar maiúsculas', () => {
    expect(cpfDosRegistros(base, 'BIA@o2inc.com.br', null)).toBe('12345678909');
    expect(cpfDosRegistros(base, 'caio@gmail.com', 'Outro Nome')).toBe('98765432100');
  });
  it('sem e-mail que bata: usa o nome exato (sem acento) só se for único', () => {
    expect(cpfDosRegistros(base, 'x@o2inc.com.br', 'Caio Lima')).toBe('98765432100');
    expect(cpfDosRegistros(base, null, 'Ana Paula')).toBeNull();
    expect(cpfDosRegistros(base, null, 'Ninguém')).toBeNull();
  });
});
