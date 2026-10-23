// ============================================================
//  Catálogo de EMPRESAS (clientes)
//  Traduce el nombre del grupo de WhatsApp → nombre limpio de
//  la empresa. Así el dashboard y los comandos pueden agrupar
//  los soportes por empresa.
//
//  Cómo funciona: si el nombre del grupo CONTIENE alguna de las
//  palabras de "match", se le asigna esa empresa.
//  ➡️ Edita esta lista cuando entre o cambie un cliente.
// ============================================================

export interface Company {
  /** Nombre bonito que se mostrará en el dashboard. */
  name: string;
  /** Palabras clave que aparecen en el nombre del grupo (en minúsculas). */
  match: string[];
}

export const COMPANIES: Company[] = [
  { name: 'Acme', match: ['acme'] },
  { name: 'Aliados / Consultoría', match: ['consultoria', 'consultoría'] },
  { name: 'CONTPAQ', match: ['contpaq'] },
  { name: 'Logística Beta', match: ['beta'] },
  { name: 'Grupo Delta', match: ['delta'] },
  { name: 'Colegio Demo', match: ['demo'] },
  { name: 'Clínica Gamma', match: ['gamma'] },
  { name: 'Interno Mi Empresa', match: ['interno', 'miempresa', 'mi empresa'] },
];

/**
 * Empresa interna. Los comandos mandados desde SU grupo ven TODO
 * (todas las empresas); los demás grupos solo ven lo suyo.
 */
export const EMPRESA_INTERNA = 'Interno Mi Empresa';

/**
 * Devuelve la empresa a la que pertenece un grupo de WhatsApp.
 * Si no coincide con ninguna, devuelve "Otra".
 */
export function companyForGroup(groupName: string | null | undefined): string {
  if (!groupName) return 'Sin empresa';
  const lower = groupName.toLowerCase();
  const found = COMPANIES.find((c) => c.match.some((m) => lower.includes(m)));
  return found ? found.name : 'Otra';
}

/**
 * Palabras clave de una empresa, para poder filtrar en la base por el
 * nombre del grupo. Devuelve null si la empresa no está en el catálogo.
 */
export function patronesDeEmpresa(companyName: string): string[] | null {
  return COMPANIES.find((c) => c.name === companyName)?.match ?? null;
}
