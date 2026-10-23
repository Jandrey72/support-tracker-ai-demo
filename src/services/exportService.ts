import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { getSupports } from './statsService.js';

/** Un caso de soporte tal como lo devuelve getSupports (con categoria/grupo). */
type SupportRow = Awaited<ReturnType<typeof getSupports>>[number];

const STATUS_LABEL: Record<string, string> = {
  open: 'Abierto',
  in_progress: 'En progreso',
  completed: 'Completado',
};

function fmtDate(d: Date | null): string {
  if (!d) return '';
  return d.toLocaleString('es-MX', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Columnas comunes a todas las exportaciones. */
function rowValues(c: SupportRow): string[] {
  return [
    fmtDate(c.createdAt),
    c.client ?? '',
    c.technician ?? '',
    c.category?.name ?? '',
    STATUS_LABEL[c.status] ?? c.status,
    c.summary ?? '',
    `${Math.round(c.confidence * 100)}%`,
  ];
}

const HEADERS = [
  'Fecha',
  'Cliente',
  'Tecnico',
  'Categoria',
  'Estado',
  'Resumen',
  'Confianza',
];

// ---------- CSV ----------
export function toCSV(cases: SupportRow[]): string {
  const escape = (v: string): string => `"${v.replace(/"/g, '""')}"`;
  const lines = [HEADERS.map(escape).join(',')];
  for (const c of cases) {
    lines.push(rowValues(c).map(escape).join(','));
  }
  return '﻿' + lines.join('\r\n'); // BOM para que Excel abra acentos bien
}

// ---------- Excel ----------
export async function toExcel(cases: SupportRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Support Tracker AI';
  const ws = wb.addWorksheet('Soportes');

  ws.columns = [
    { header: 'Fecha', key: 'fecha', width: 18 },
    { header: 'Cliente', key: 'cliente', width: 24 },
    { header: 'Tecnico', key: 'tecnico', width: 20 },
    { header: 'Categoria', key: 'categoria', width: 16 },
    { header: 'Estado', key: 'estado', width: 14 },
    { header: 'Resumen', key: 'resumen', width: 50 },
    { header: 'Confianza', key: 'confianza', width: 12 },
  ];

  // Estilo del encabezado.
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF2563EB' },
  };

  for (const c of cases) {
    const v = rowValues(c);
    ws.addRow(v);
  }

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ---------- PDF ----------
export function toPDF(cases: SupportRow[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Titulo
    doc.fontSize(20).fillColor('#2563EB').text('Reporte de Soportes', {
      align: 'center',
    });
    doc
      .fontSize(10)
      .fillColor('#666')
      .text(`Generado: ${fmtDate(new Date())}`, { align: 'center' });
    doc.moveDown(0.5);
    doc
      .fontSize(11)
      .fillColor('#000')
      .text(`Total de soportes: ${cases.length}`, { align: 'center' });
    doc.moveDown(1);

    // Cada soporte como un bloque legible.
    for (const c of cases) {
      const v = rowValues(c);
      doc.fontSize(12).fillColor('#111').text(`${v[1] || 'Cliente sin identificar'}`, {
        continued: false,
      });
      doc
        .fontSize(10)
        .fillColor('#444')
        .text(
          `${v[0]}  •  Tecnico: ${v[2] || '—'}  •  Categoria: ${v[3] || '—'}  •  Estado: ${v[4]}  •  Confianza: ${v[6]}`,
        );
      if (v[5]) {
        doc.fontSize(10).fillColor('#000').text(v[5]);
      }
      doc.moveDown(0.4);
      doc
        .strokeColor('#e5e7eb')
        .lineWidth(0.5)
        .moveTo(doc.x, doc.y)
        .lineTo(555, doc.y)
        .stroke();
      doc.moveDown(0.4);

      // Salto de pagina si nos quedamos sin espacio.
      if (doc.y > 760) doc.addPage();
    }

    if (cases.length === 0) {
      doc.fontSize(12).fillColor('#666').text('No hay soportes registrados todavia.', {
        align: 'center',
      });
    }

    doc.end();
  });
}
