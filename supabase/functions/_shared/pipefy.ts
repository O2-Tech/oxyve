// CPF de quem não preencheu no perfil: procura na base "Pessoas" do Pipefy
// (PIPEFY_PESSOAS_TABLE) pelo e-mail O2 ou pessoal, e por último pelo nome.
// Só leitura.

const API = "https://api.pipefy.com/graphql";

interface Campo { field: { id: string }; value: string | null }
interface Registro { title: string; record_fields: Campo[] }

const soDigitos = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
const normalizar = (s: string | null | undefined) =>
  (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Acha o CPF no registro que bate com o e-mail; sem e-mail, com o nome exato. */
export function cpfDosRegistros(registros: Registro[], email: string | null, nome: string | null): string | null {
  const valor = (r: Registro, id: string) => r.record_fields.find((c) => c.field.id === id)?.value ?? null;
  const cpf = (r: Registro) => {
    const d = soDigitos(valor(r, "cpf"));
    return d.length === 11 ? d : null;
  };
  const e = normalizar(email);
  if (e) {
    const r = registros.find((r) => [valor(r, "e_mail_o2"), valor(r, "copy_of_e_mail_o2")].some((v) => normalizar(v) === e));
    if (r && cpf(r)) return cpf(r);
  }
  const n = normalizar(nome);
  if (!n) return null;
  const mesmos = registros.filter((r) => normalizar(r.title) === n && cpf(r));
  return mesmos.length === 1 ? cpf(mesmos[0]) : null;
}

export async function buscarCpfNoPipefy(
  email: string | null,
  nome: string | null,
  env: { token?: string; tabela?: string } = { token: Deno.env.get("PIPEFY_TOKEN"), tabela: Deno.env.get("PIPEFY_PESSOAS_TABLE") },
): Promise<string | null> {
  if (!env.token || !env.tabela) return null;
  const registros: Registro[] = [];
  let depois: string | null = null;
  for (let pagina = 0; pagina < 20; pagina++) {
    const query = `query($t: ID!, $a: String) { table(id: $t) { table_records(first: 50, after: $a) {
      pageInfo { hasNextPage endCursor } edges { node { title record_fields { field { id } value } } } } } }`;
    const res = await fetch(API, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { t: env.tabela, a: depois } }),
    });
    if (!res.ok) return null;
    const pg = (await res.json())?.data?.table?.table_records;
    if (!pg) return null;
    registros.push(...pg.edges.map((e: { node: Registro }) => e.node));
    if (!pg.pageInfo.hasNextPage) break;
    depois = pg.pageInfo.endCursor;
  }
  return cpfDosRegistros(registros, email, nome);
}
