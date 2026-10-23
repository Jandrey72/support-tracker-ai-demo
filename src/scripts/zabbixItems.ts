// ============================================================
//  ¿Qué métricas tiene el UPS en Zabbix?
//
//  Sirve para saber qué se PUEDE poner en el aviso de WhatsApp antes de
//  programarlo: si no existe la carga de la batería, no hay forma de
//  anunciarla. Solo LEE; no cambia nada en Zabbix.
//
//  Uso (en la VM, donde el .env tiene el token):
//     npm run zabbix:items            → los equipos de ZABBIX_HOSTS
//     npm run zabbix:items -- UPS     → los que contengan "UPS"
// ============================================================

import { env } from '../config/env.js';
import { llamarApi } from '../services/zabbixService.js';

interface Host { hostid: string; host: string; name: string }
interface Item {
  itemid: string;
  name: string;
  key_: string;
  lastvalue: string;
  units: string;
  lastclock: string;
}

/** Palabras que delatan una métrica útil para el aviso de corte de luz. */
const INTERESANTES = [
  'batt', 'bateria', 'batería', 'charge', 'carga', 'capacity', 'capacidad',
  'runtime', 'remaining', 'restante', 'autonom', 'time', 'tiempo',
  'load', 'output', 'input', 'volt', 'temp', 'status', 'estado',
];

function esInteresante(i: Item): boolean {
  const texto = `${i.name} ${i.key_}`.toLowerCase();
  return INTERESANTES.some((p) => texto.includes(p));
}

async function main(): Promise<void> {
  if (!env.ZABBIX_URL || !env.ZABBIX_TOKEN_API) {
    console.error('❌ Falta ZABBIX_URL o ZABBIX_TOKEN_API en el .env');
    process.exit(1);
  }

  const filtro = process.argv.slice(2).join(' ').trim();
  const buscar = filtro ? [filtro] : env.ZABBIX_HOSTS;

  const hosts = (await llamarApi('host.get', {
    output: ['hostid', 'host', 'name'],
    ...(buscar.length ? { search: { name: buscar }, searchByAny: true } : {}),
  })) as Host[];

  if (!hosts.length) {
    console.log('No se encontró ningún equipo con ese nombre.');
    return;
  }

  for (const h of hosts) {
    console.log(`\n=== ${h.name} (${h.host}) ===`);

    const items = (await llamarApi('item.get', {
      output: ['itemid', 'name', 'key_', 'lastvalue', 'units', 'lastclock'],
      hostids: h.hostid,
      sortfield: 'name',
    })) as Item[];

    const utiles = items.filter(esInteresante);
    console.log(`${items.length} métricas en total · ${utiles.length} que podrían servir:\n`);

    for (const i of utiles) {
      const cuando = i.lastclock && i.lastclock !== '0'
        ? new Date(Number(i.lastclock) * 1000).toLocaleString('es-MX')
        : 'SIN DATO';
      const valor = i.lastvalue === '' ? '(vacío)' : i.lastvalue;
      console.log(`  ${i.name}`);
      console.log(`     clave: ${i.key_}`);
      console.log(`     valor: ${valor} ${i.units}   ·   último dato: ${cuando}\n`);
    }
  }
}

main().catch((err) => {
  console.error('❌', (err as Error).message);
  process.exit(1);
});
