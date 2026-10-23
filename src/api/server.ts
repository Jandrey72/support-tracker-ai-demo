import express from 'express';
import path from 'node:path';
import { env } from '../config/env.js';
import {
  requireAuth,
  securityHeaders,
  loginHandler,
  logoutHandler,
  meHandler,
  authEnabled,
} from './auth.js';
import { logger } from '../config/logger.js';
import {
  estadoDelEquipo,
  marcarDisponibilidad,
  avisarAlEquipo,
} from '../services/availabilityService.js';
import {
  AL_SALIR_QUEDA_UNO,
  AL_SALIR_NADIE_QUEDA,
  AL_VOLVER,
  AL_VOLVER_SIN_NADIE,
  frase,
} from '../config/frasesAusencia.js';
import {
  getSupports,
  getStats,
  getSupportMessages,
  deleteSupport,
  recoverSupport,
  deleteSupportForever,
  getVistaTecnico,
  getProblemasRepetidos,
  getDatosReporteMensual,
  type SupportFilters,
} from '../services/statsService.js';
import { buscarParecidos } from '../services/parecidosService.js';
import {
  generarReporteMensualPDF,
  interpretarMes,
  mesAnterior,
  nombreArchivoReporte,
} from '../services/reporteMensualService.js';
import { COMPANIES, EMPRESA_INTERNA, companyForGroup } from '../config/companies.js';
import { toCSV, toExcel, toPDF } from '../services/exportService.js';
import {
  rutaAbsoluta,
  tipoDeArchivo,
  guardarCapturaManual,
  borrarArchivo,
  extensionPermitida,
  MAX_EVIDENCIA_BYTES,
} from '../services/mediaService.js';
import { randomUUID, randomBytes } from 'node:crypto';
import { getBotStatus, setManualStop, getCurrentSock } from '../whatsapp/botState.js';
import {
  notifyManualTicket,
  notificarAsignacion,
  borrarAvisosDeWhatsApp,
  avisarAlertaMonitoreo,
} from '../whatsapp/notifier.js';
import { nextTicketNumber } from '../services/ticketNumber.js';
import { elegirTecnico, cargaActual } from '../services/assignmentService.js';
import {
  tecnicosEnSoporte,
  findTechnicianByName,
  findTechnicianByNumber,
  looksLikeTechnicianName,
  last10,
  TECHNICIANS,
} from '../config/technicians.js';
import { prisma } from '../db/client.js';

/**
 * Decide si un mensaje lo escribio alguien del equipo Mi Empresa.
 * Primero por numero (lo confiable) y, si WhatsApp lo enmascaro con @lid,
 * caemos al nombre. Solo sirve para pintarlo distinto en el dashboard.
 */
function esDelEquipo(m: {
  senderName: string | null;
  user?: { waId: string } | null;
}): boolean {
  const numero = m.user?.waId ? m.user.waId.split('@')[0].split(':')[0] : null;
  if (findTechnicianByNumber(last10(numero))) return true;
  return looksLikeTechnicianName(m.senderName);
}

/** Extrae los filtros de la query string. */
function filtersFrom(query: Record<string, unknown>): SupportFilters {
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;
  const idsRaw = str(query.ids);
  return {
    client: str(query.client),
    technician: str(query.technician),
    status: str(query.status),
    category: str(query.category),
    group: str(query.group),
    ids: idsRaw ? idsRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    papelera: query.papelera === '1',
    dateFrom: str(query.dateFrom),
    dateTo: str(query.dateTo),
  };
}

export function startWebServer(): void {
  const app = express();
  app.set('trust proxy', 1); // para que req.ip sea real detrás de un proxy
  app.use(express.json({ limit: '1mb' }));
  app.use(securityHeaders);

  // --- Sesión ---
  app.post('/api/auth/login', loginHandler);
  app.post('/api/auth/logout', logoutHandler);
  app.get('/api/auth/me', meHandler);

  // --- Alertas de monitoreo (Zabbix) ---
  // Va ANTES de requireAuth a propósito: Zabbix no tiene cookie de navegador.
  // Su seguridad es el token, que se compara en la primera línea del handler.
  app.post('/api/alertas/zabbix', async (req, res) => {
    if (!env.ZABBIX_TOKEN) {
      logger.warn('Llegó una alerta de Zabbix pero ZABBIX_TOKEN no está configurado.');
      return res.status(503).json({ error: 'Endpoint de alertas no configurado' });
    }

    const enviado = String(req.header('x-zabbix-token') ?? req.body?.token ?? '');
    if (enviado !== env.ZABBIX_TOKEN) {
      logger.warn(`Alerta rechazada: token inválido (desde ${req.ip}).`);
      return res.status(401).json({ error: 'Token inválido' });
    }

    const texto = String(req.body?.texto ?? '').trim();
    if (!texto) return res.status(400).json({ error: 'Falta el campo "texto"' });

    const ok = await avisarAlertaMonitoreo(texto);
    if (!ok) return res.status(502).json({ error: 'No se pudo publicar en WhatsApp' });

    logger.info('⚡ Alerta de monitoreo publicada en WhatsApp.');
    return res.json({ ok: true });
  });

  // --- Página pública de estado de un ticket (idea #7) ---
  // Va ANTES de requireAuth: el cliente no tiene usuario. Su "llave" es el
  // código secreto del link, que solo existe si alguien del equipo lo creó
  // desde el dashboard. Solo se muestra lo que el cliente ya sabe o debe
  // saber: nada de teléfonos, conversación interna, comentarios ni confianza.
  const CODIGO_VALIDO = /^[A-Za-z0-9_-]{20,64}$/;

  // Freno sencillo contra quien intente adivinar códigos a lo loco.
  const visitas = new Map<string, { n: number; desde: number }>();
  const demasiadas = (ip: string): boolean => {
    const ahora = Date.now();
    const v = visitas.get(ip);
    if (!v || ahora - v.desde > 60_000) {
      visitas.set(ip, { n: 1, desde: ahora });
      return false;
    }
    v.n++;
    return v.n > 30; // 30 consultas por minuto por IP le sobran a un cliente
  };

  app.get('/estado/:codigo', (_req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'estado.html'));
  });

  app.get('/api/publico/estado/:codigo', async (req, res) => {
    if (demasiadas(req.ip ?? '?')) {
      return res.status(429).json({ error: 'Demasiadas consultas. Intenta en un minuto.' });
    }
    const codigo = String(req.params.codigo);
    if (!CODIGO_VALIDO.test(codigo)) return res.status(404).json({ error: 'Link no válido' });

    try {
      const c = await prisma.supportCase.findFirst({
        where: { publicToken: codigo, deletedAt: null },
        select: {
          ticketNumber: true,
          summary: true,
          status: true,
          createdAt: true,
          resolvedAt: true,
          resolutionNote: true,
          assignedTo: true,
          technician: true,
          updatedAt: true,
          category: { select: { name: true } },
          group: { select: { name: true } },
        },
      });
      if (!c) return res.status(404).json({ error: 'Link no válido o ya no disponible' });

      // Solo el primer nombre de quien atiende: "Luis Pérez" → "Luis".
      const quien = (c.assignedTo || c.technician || '').split(/\s+/)[0] || null;
      return res.json({
        ticketNumber: c.ticketNumber,
        empresa: companyForGroup(c.group?.name),
        categoria: c.category?.name ?? null,
        resumen: c.summary,
        estado: c.status,
        recibido: c.createdAt,
        resuelto: c.resolvedAt,
        solucion: c.resolutionNote,
        atiende: quien,
        actualizado: c.updatedAt,
      });
    } catch (err) {
      logger.error(err);
      return res.status(500).json({ error: 'Error consultando el estado' });
    }
  });

  // A partir de aquí, todo requiere sesión iniciada.
  app.use(requireAuth);

  // Archivos estaticos (el dashboard HTML).
  app.use(express.static(path.join(process.cwd(), 'public')));

  app.get('/api/status', (_req, res) => {
    res.json({ status: getBotStatus() });
  });

  app.post('/api/bot/stop', async (_req, res) => {
    setManualStop(true);
    const sock = getCurrentSock();
    if (sock) {
      try { await sock.end(undefined); } catch { /* ignore */ }
    }
    res.json({ ok: true });
  });

  app.post('/api/bot/start', async (_req, res) => {
    setManualStop(false);
    const { startBot } = await import('../whatsapp/socket.js');
    startBot().catch(() => {});
    res.json({ ok: true });
  });
  app.post('/api/supports', async (req, res) => {
  try {
    const { client, technician, summary, categoryName, status, severity, assignedTo } = req.body as {
      client?: string; technician?: string; summary: string;
      categoryName?: string; status?: string; severity?: string; assignedTo?: string;
    };

    if (!summary?.trim()) {
      res.status(400).json({ error: 'El resumen es obligatorio' });
      return;
    }

    let categoryId: string | undefined;
    if (categoryName?.trim()) {
      const cat = await prisma.supportCategory.upsert({
        where: { name: categoryName.trim() },
        update: {},
        create: { name: categoryName.trim() },
      });
      categoryId = cat.id;
    }

    const group = await prisma.group.upsert({
      where: { waId: 'manual' },
      update: {},
      create: { waId: 'manual', name: 'Manual', isActive: false },
    });

    const ticketNumber = await nextTicketNumber();

    // Si no dijeron a quién, se lo damos al técnico con menos carga.
    const responsable = assignedTo?.trim()
      ? assignedTo.trim()
      : (await elegirTecnico(technician))?.name ?? null;

    const ticket = await prisma.supportCase.create({
      data: {
        client: client?.trim() || null,
        technician: technician?.trim() || null,
        assignedTo: responsable,
        summary: summary.trim(),
        status: status ?? 'open',
        severity: severity?.trim() || 'Media',
        source: 'manual',
        confidence: 1,
        groupId: group.id,
        categoryId,
        ticketNumber,
        // Nació de una persona: la IA no lo toca.
        manualEditAt: new Date(),
      },
    });

    // Avisos (sin frenar la respuesta si WhatsApp falla).
    notifyManualTicket(ticket).catch(() => {});
    if (responsable && ticket.status !== 'completed') {
      notificarAsignacion({
        supportCaseId: ticket.id,
        ticketNumber: ticket.ticketNumber,
        assignedTo: responsable,
        client: ticket.client,
        summary: ticket.summary,
        severity: ticket.severity,
      }).catch(() => {});
    }

    res.status(201).json(ticket);
  } catch (err) {
    logger.error(err);
    res.status(500).json({ error: 'Error creando ticket' });
  }
});

  app.put('/api/supports/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const {
        client, technician, summary, categoryName, status, severity, resolutionNote, assignedTo,
      } = req.body as {
        client?: string; technician?: string; summary?: string; categoryName?: string;
        status?: string; severity?: string; resolutionNote?: string; assignedTo?: string;
      };

      let categoryId: string | undefined;
      if (categoryName?.trim()) {
        const cat = await prisma.supportCategory.upsert({
          where: { name: categoryName.trim() },
          update: {},
          create: { name: categoryName.trim() },
        });
        categoryId = cat.id;
      }

      const updated = await prisma.supportCase.update({
        where: { id },
        data: {
          ...(client !== undefined && { client: client.trim() || null }),
          ...(technician !== undefined && { technician: technician.trim() || null }),
          ...(summary?.trim() && { summary: summary.trim() }),
          ...(status && { status }),
          ...(severity?.trim() && { severity: severity.trim() }),
          ...(resolutionNote !== undefined && { resolutionNote: resolutionNote.trim() || null }),
          ...(assignedTo !== undefined && { assignedTo: assignedTo.trim() || null }),
          ...(categoryId && { categoryId }),
          ...(status === 'completed' && { resolvedAt: new Date() }),
          ...(status && status !== 'completed' && { resolvedAt: null }),
          // A partir de aquí manda la persona: la IA ya no sobrescribe
          // este ticket, solo le sigue enganchando mensajes como evidencia.
          manualEditAt: new Date(),
        },
      });

      res.json(updated);
    } catch (err) {
      logger.error(err);
      res.status(500).json({ error: 'Error actualizando ticket' });
    }
  });

  // --- Comentarios de ticket ---
  app.get('/api/supports/:id/comments', async (req, res) => {
    try {
      const comments = await prisma.ticketComment.findMany({
        where: { supportCaseId: req.params.id },
        orderBy: { createdAt: 'asc' },
      });
      res.json(comments);
    } catch (err) {
      logger.error(err);
      res.status(500).json({ error: 'Error obteniendo comentarios' });
    }
  });

  app.post('/api/supports/:id/comments', async (req, res) => {
    try {
      const { content, author } = req.body as { content: string; author?: string };
      if (!content?.trim()) {
        res.status(400).json({ error: 'El contenido es obligatorio' });
        return;
      }
      const comment = await prisma.ticketComment.create({
        data: {
          content: content.trim(),
          author: author?.trim() || null,
          supportCaseId: req.params.id,
        },
      });
      res.status(201).json(comment);
    } catch (err) {
      logger.error(err);
      res.status(500).json({ error: 'Error agregando comentario' });
    }
  });

  app.delete('/api/supports/:id/comments/:commentId', async (req, res) => {
    try {
      await prisma.ticketComment.delete({ where: { id: req.params.commentId } });
      res.json({ ok: true });
    } catch (err) {
      logger.error(err);
      res.status(500).json({ error: 'No se pudo borrar el comentario' });
    }
  });

  // Equipo de soporte: cuánta carga trae cada quien y si está disponible.
  app.get('/api/tecnicos', async (_req, res) => {
    try {
      const [carga, estado] = await Promise.all([cargaActual(), estadoDelEquipo()]);
      const porNombre = new Map(estado.map((e) => [e.name, e]));
      res.json(
        tecnicosEnSoporte().map((t) => ({
          name: t.name,
          abiertos: carga.get(t.name) ?? 0,
          disponible: porNombre.get(t.name)?.disponible ?? true,
          motivo: porNombre.get(t.name)?.motivo ?? null,
          desde: porNombre.get(t.name)?.desde ?? null,
        })),
      );
    } catch (err) {
      logger.error(err);
      res.status(500).json({ error: 'Error obteniendo el equipo' });
    }
  });

  /**
   * Botón de "salí / ya volví" desde el dashboard.
   * Mismo efecto que /ausente y /disponible en WhatsApp: el aviso con la
   * frase sale en el grupo interno para que el equipo se entere igual.
   */
  app.post('/api/tecnicos/:name/disponibilidad', async (req, res) => {
    try {
      const disponible = Boolean(req.body?.disponible);
      const motivo = typeof req.body?.motivo === 'string' ? req.body.motivo.trim() : null;
      const estado = await marcarDisponibilidad(req.params.name, disponible, motivo || null);
      if (!estado) {
        res.status(404).json({ error: 'Ese técnico no está en el equipo de soporte' });
        return;
      }

      const otros = (await estadoDelEquipo()).filter(
        (e) => e.disponible && e.name !== estado.name,
      );
      const nombres = otros.map((o) => o.name).join(' y ');
      const texto = disponible
        ? otros.length
          ? frase(AL_VOLVER, { ausente: estado.name, presente: nombres })
          : frase(AL_VOLVER_SIN_NADIE, { ausente: estado.name })
        : otros.length
          ? frase(AL_SALIR_QUEDA_UNO, { ausente: estado.name, presente: nombres, motivo })
          : frase(AL_SALIR_NADIE_QUEDA, { ausente: estado.name, motivo });

      // Por privado a los otros técnicos (o al grupo, según AVISO_AUSENCIA).
      void avisarAlEquipo(texto, estado.name);
      res.json(estado);
    } catch (err) {
      logger.error(err);
      res.status(500).json({ error: 'No se pudo cambiar la disponibilidad' });
    }
  });

  /**
   * Diagnóstico: ¿a qué JID le escribiría el bot a cada técnico, y ese número
   * existe en WhatsApp? NO manda ningún mensaje, solo pregunta.
   * Sirve para saber si el aviso al privado va a llegar ANTES de crear un ticket.
   */
  app.get('/api/diagnostico/whatsapp', async (_req, res) => {
    const sock = getCurrentSock();
    if (!sock) {
      res.json({
        botConectado: false,
        problema:
          'El bot NO está conectado en este proceso. Si abriste el dashboard con ' +
          '"npm run dashboard", ese no tiene bot: usa "npm run dev".',
        tecnicos: [],
      });
      return;
    }

    const tecnicos = [];
    for (const t of tecnicosEnSoporte()) {
      const diez = last10(t.number);
      const intentos = [];
      let jidBueno = null;
      for (const numero of [`521${diez}`, `52${diez}`]) {
        try {
          const [r] = (await sock.onWhatsApp(numero)) ?? [];
          const existe = Boolean(r?.exists);
          intentos.push({ numero, existe, jid: r?.jid ?? null });
          if (existe && r?.jid && !jidBueno) jidBueno = r.jid;
        } catch (err) {
          intentos.push({ numero, error: (err as Error).message });
        }
      }
      tecnicos.push({
        nombre: t.name,
        numeroEnCatalogo: t.number,
        intentos,
        leLlegaria: jidBueno,
        veredicto: jidBueno ? '✅ sí le llega' : '❌ WhatsApp no reconoce este número',
      });
    }

    res.json({ botConectado: true, miNumero: sock.user?.id ?? null, tecnicos });
  });

  // --- API ---
  app.get('/api/stats', async (req, res) => {
    try {
      res.json(await getStats(filtersFrom(req.query)));
    } catch (err) {
      logger.error(err);
      res.status(500).json({ error: 'Error obteniendo estadisticas' });
    }
  });

  app.get('/api/supports', async (req, res) => {
    try {
      const cases = await getSupports(filtersFrom(req.query));
      res.json(
        cases.map((c) => ({
          id: c.id,
          createdAt: c.createdAt,
          client: c.client,
          technician: c.technician,
          category: c.category?.name ?? null,
          status: c.status,
          summary: c.summary,
          confidence: c.confidence,
          group: c.group.name,
          messageCount: c._count.messages,
          severity: c.severity,
          source: c.source,
          ticketNumber: c.ticketNumber,
          resolutionNote: c.resolutionNote,
          resolvedAt: c.resolvedAt,
          assignedTo: c.assignedTo,
          manualEditAt: c.manualEditAt,
        })),
      );
    } catch (err) {
      logger.error(err);
      res.status(500).json({ error: 'Error obteniendo soportes' });
    }
  });

  // Elimina un soporte por su id. OJO: no tiene deshacer.
  /**
   * Si la petición trae ?wa=1, borra de WhatsApp los avisos que el bot publicó
   * sobre ese ticket. Se hace ANTES de borrar el caso: al borrarlo se van sus
   * registros y ya no sabríamos qué mensajes quitar.
   */
  const limpiarWhatsApp = async (id: string, query: Record<string, unknown>) => {
    if (query.wa !== '1') return null;
    try {
      return await borrarAvisosDeWhatsApp(id);
    } catch (err) {
      logger.warn(`No se pudieron borrar los avisos de WhatsApp: ${(err as Error).message}`);
      return { borrados: 0, fallidos: 0, sinBot: false };
    }
  };

  /**
   * Borra del disco las imágenes de un ticket: las capturas subidas a mano y
   * las fotos que se bajaron de WhatsApp. Solo para el borrado DEFINITIVO —
   * en la papelera se conservan, porque el ticket todavía se puede recuperar.
   */
  const borrarArchivosDelTicket = async (id: string) => {
    const [capturas, mensajes] = await Promise.all([
      prisma.evidence.findMany({ where: { supportCaseId: id }, select: { storedPath: true } }),
      prisma.message.findMany({
        where: { supportCaseId: id, mediaUrl: { not: null } },
        select: { mediaUrl: true },
      }),
    ]);
    for (const c of capturas) await borrarArchivo(c.storedPath);
    for (const m of mensajes) if (m.mediaUrl) await borrarArchivo(m.mediaUrl);
    const total = capturas.length + mensajes.length;
    if (total) logger.info(`🗑️  ${total} imagen(es) borradas del disco con el ticket.`);
  };

  app.delete('/api/supports/:id', async (req, res) => {
    try {
      const whatsapp = await limpiarWhatsApp(req.params.id, req.query as Record<string, unknown>);
      await deleteSupport(req.params.id);
      res.json({ ok: true, whatsapp });
    } catch (err) {
      logger.error(err);
      res.status(500).json({ error: 'No se pudo eliminar el soporte' });
    }
  });

  app.post('/api/supports/:id/recover', async (req, res) => {
    try {
      await recoverSupport(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      logger.error(err);
      res.status(500).json({ error: 'No se pudo recuperar el soporte' });
    }
  });  

  // Borrado DEFINITIVO (desde la papelera). No se recupera.
  app.delete('/api/supports/:id/forever', async (req, res) => {
    try {
      const whatsapp = await limpiarWhatsApp(req.params.id, req.query as Record<string, unknown>);
      await borrarArchivosDelTicket(req.params.id);
      await deleteSupportForever(req.params.id);
      res.json({ ok: true, whatsapp });
    } catch (err) {
      logger.error(err);
      res.status(500).json({ error: 'No se pudo borrar definitivamente' });
    }
  });

  // La conversacion (evidencia) de un soporte especifico.
  app.get('/api/supports/:id/messages', async (req, res) => {
    try {
      const messages = await getSupportMessages(req.params.id);
      res.json(
        messages.map((m) => ({
          id: m.id,
          sender: m.senderName,
          content: m.content,
          type: m.type, // text | image | video | audio | document
          mediaUrl: m.mediaUrl, // por ahora null; se llena al bajar las fotos
          timestamp: m.timestamp,
          esTecnico: esDelEquipo(m),
        })),
      );
    } catch (err) {
      logger.error(err);
      res.status(500).json({ error: 'Error obteniendo la evidencia' });
    }
  });

  /**
   * Sirve una imagen de evidencia.
   *
   * Va por aquí y NO por express.static a propósito: así hereda `requireAuth`
   * y nadie ve las capturas de un cliente sin haber entrado al dashboard.
   * El navegador manda solita la cookie de sesión al cargar el <img>.
   */
  app.get('/api/evidencia/mensaje/:messageId', async (req, res) => {
    try {
      const msg = await prisma.message.findUnique({
        where: { id: req.params.messageId },
        select: { mediaUrl: true },
      });
      if (!msg?.mediaUrl) {
        res.status(404).json({ error: 'Ese mensaje no tiene evidencia' });
        return;
      }

      // Aunque el nombre lo generamos nosotros, se vuelve a comprobar que la
      // ruta no se salga de uploads/. Nunca confiar en lo que viene de la base.
      const abs = rutaAbsoluta(msg.mediaUrl);
      if (!abs) {
        res.status(400).json({ error: 'Ruta de evidencia inválida' });
        return;
      }

      res.type(tipoDeArchivo(abs));
      res.sendFile(abs, (err) => {
        if (err && !res.headersSent) res.status(404).end();
      });
    } catch (err) {
      logger.error(err);
      res.status(500).json({ error: 'Error leyendo la evidencia' });
    }
  });

  /** Lista las capturas subidas a mano de un ticket. */
  app.get('/api/supports/:id/evidencia', async (req, res) => {
    try {
      const archivos = await prisma.evidence.findMany({
        where: { supportCaseId: req.params.id },
        orderBy: { createdAt: 'asc' },
        select: { id: true, fileName: true, mimeType: true, size: true, uploadedBy: true, createdAt: true },
      });
      res.json(archivos);
    } catch (err) {
      logger.error(err);
      res.status(500).json({ error: 'Error listando la evidencia' });
    }
  });

  /**
   * Sube una captura a un ticket.
   *
   * El cuerpo son los BYTES de la imagen tal cual (no base64: pesa 33% menos y
   * no hay que subirle el límite al parser de JSON). El nombre original viaja en
   * la cabecera X-File-Name y solo se guarda para mostrarlo — el nombre real del
   * archivo en disco lo generamos aquí.
   */
  app.post(
    '/api/supports/:id/evidencia',
    express.raw({ type: ['image/*'], limit: MAX_EVIDENCIA_BYTES }),
    async (req, res) => {
      try {
        const mime = req.get('content-type') ?? '';
        if (!extensionPermitida(mime)) {
          res.status(415).json({ error: 'Solo se aceptan imágenes (JPG, PNG, WEBP o GIF)' });
          return;
        }

        const buffer = req.body as Buffer;
        if (!Buffer.isBuffer(buffer) || !buffer.length) {
          res.status(400).json({ error: 'No llegó ninguna imagen' });
          return;
        }

        const ticket = await prisma.supportCase.findUnique({
          where: { id: req.params.id },
          select: { id: true, ticketNumber: true },
        });
        if (!ticket) {
          res.status(404).json({ error: 'Ese ticket no existe' });
          return;
        }

        const storedPath = await guardarCapturaManual(buffer, mime, randomUUID());
        if (!storedPath) {
          res.status(400).json({ error: 'No se pudo guardar la imagen' });
          return;
        }

        // El nombre que manda el navegador se limpia: solo es una etiqueta.
        // Viaja codificado porque una cabecera HTTP no admite acentos ni emojis.
        let crudo = req.get('x-file-name') ?? 'captura';
        try {
          crudo = decodeURIComponent(crudo);
        } catch {
          // Venía mal codificado: nos quedamos con el texto tal cual.
        }
        const fileName = crudo.slice(0, 120).replace(/[\r\n<>"]/g, '').trim() || 'captura';

        const evidencia = await prisma.evidence.create({
          data: {
            fileName,
            storedPath,
            mimeType: mime.split(';')[0].trim(),
            size: buffer.length,
            uploadedBy: env.DASHBOARD_USER ?? null,
            supportCaseId: ticket.id,
          },
          select: { id: true, fileName: true, mimeType: true, size: true, createdAt: true },
        });

        logger.info(`📎 Captura agregada a ${ticket.ticketNumber ?? ticket.id}: ${fileName}`);
        res.status(201).json(evidencia);
      } catch (err) {
        logger.error(err);
        res.status(500).json({ error: 'Error subiendo la imagen' });
      }
    },
  );

  /** Borra una captura: primero el registro, luego el archivo del disco. */
  app.delete('/api/supports/:id/evidencia/:evidenciaId', async (req, res) => {
    try {
      const ev = await prisma.evidence.findFirst({
        where: { id: req.params.evidenciaId, supportCaseId: req.params.id },
      });
      if (!ev) {
        res.status(404).json({ error: 'Esa evidencia no existe en este ticket' });
        return;
      }
      await prisma.evidence.delete({ where: { id: ev.id } });
      await borrarArchivo(ev.storedPath);
      res.json({ ok: true });
    } catch (err) {
      logger.error(err);
      res.status(500).json({ error: 'Error borrando la evidencia' });
    }
  });

  /** Sirve una captura subida a mano (con sesión, igual que las de WhatsApp). */
  app.get('/api/evidencia/archivo/:evidenciaId', async (req, res) => {
    try {
      const ev = await prisma.evidence.findUnique({
        where: { id: req.params.evidenciaId },
        select: { storedPath: true },
      });
      if (!ev) {
        res.status(404).json({ error: 'No existe' });
        return;
      }
      const abs = rutaAbsoluta(ev.storedPath);
      if (!abs) {
        res.status(400).json({ error: 'Ruta inválida' });
        return;
      }
      res.type(tipoDeArchivo(abs));
      res.sendFile(abs, (err) => {
        if (err && !res.headersSent) res.status(404).end();
      });
    } catch (err) {
      logger.error(err);
      res.status(500).json({ error: 'Error leyendo la imagen' });
    }
  });

  // --- Exportaciones ---
  // El nombre del archivo lleva la fecha para no sobrescribir descargas.
  const stamp = () => new Date().toISOString().slice(0, 10);

  // --- Vista por técnico (idea #6) ---
  app.get('/api/tecnicos/:name/vista', async (req, res) => {
    const t = findTechnicianByName(String(req.params.name));
    if (!t) return res.status(404).json({ error: 'No conozco a ese técnico' });
    try {
      return res.json(await getVistaTecnico(t.name));
    } catch (err) {
      logger.error(err);
      return res.status(500).json({ error: 'Error armando la vista del técnico' });
    }
  });

  // Todo el equipo (no solo los de rotación), para el selector de la vista.
  app.get('/api/equipo', (_req, res) => {
    res.json(TECHNICIANS.map((t) => ({ name: t.name, enSoporte: t.enSoporte })));
  });

  // --- "Esto ya pasó antes" (idea #5) ---
  app.get('/api/supports/:id/parecidos', async (req, res) => {
    try {
      return res.json(await buscarParecidos(String(req.params.id), 5));
    } catch (err) {
      logger.error(err);
      return res.status(500).json({ error: 'Error buscando parecidos' });
    }
  });

  // --- Problemas repetidos (idea #3) ---
  app.get('/api/repetidos', async (_req, res) => {
    try {
      return res.json({
        dias: env.REPETIDOS_DIAS,
        minimo: env.REPETIDOS_MINIMO,
        lista: await getProblemasRepetidos(env.REPETIDOS_DIAS, env.REPETIDOS_MINIMO),
      });
    } catch (err) {
      logger.error(err);
      return res.status(500).json({ error: 'Error buscando repetidos' });
    }
  });

  // --- Reporte mensual por cliente (idea #1) ---
  // /api/reporte-mensual?empresa=Acme&mes=2026-08  (mes vacío = el pasado)
  app.get('/api/reporte-mensual/empresas', (_req, res) => {
    res.json(COMPANIES.filter((c) => c.name !== EMPRESA_INTERNA).map((c) => c.name));
  });

  app.get('/api/reporte-mensual', async (req, res) => {
    const empresa = COMPANIES.find((c) => c.name === String(req.query.empresa ?? ''))?.name;
    if (!empresa) return res.status(400).json({ error: 'Empresa no válida' });
    const cual = req.query.mes ? interpretarMes(String(req.query.mes)) : mesAnterior();
    if (!cual) return res.status(400).json({ error: 'Mes no válido (usa AAAA-MM)' });

    try {
      const datos = await getDatosReporteMensual(empresa, cual.anio, cual.mes);
      const pdf = await generarReporteMensualPDF(datos);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${nombreArchivoReporte(empresa, cual.anio, cual.mes)}"`,
      );
      return res.send(pdf);
    } catch (err) {
      logger.error(err);
      return res.status(500).json({ error: 'Error generando el reporte' });
    }
  });

  // --- Link público de un ticket (idea #7) ---
  // Crear (o recuperar el que ya tiene) y revocar. Solo desde el dashboard.
  app.post('/api/supports/:id/link-publico', async (req, res) => {
    try {
      const caso = await prisma.supportCase.findUnique({
        where: { id: String(req.params.id) },
        select: { publicToken: true, ticketNumber: true, updatedAt: true },
      });
      if (!caso) return res.status(404).json({ error: 'Ticket no encontrado' });

      const codigo = caso.publicToken ?? randomBytes(24).toString('base64url');
      if (!caso.publicToken) {
        await prisma.supportCase.update({
          where: { id: String(req.params.id) },
          // updatedAt se deja IGUAL a propósito: el bot usa esa fecha para
          // decidir a qué caso abierto sumar mensajes nuevos (ventana de 4 h).
          // Crear un link no es "movimiento" del caso; si la tocáramos, un
          // ticket viejo empezaría a jalar mensajes que no son suyos.
          data: { publicToken: codigo, updatedAt: caso.updatedAt },
        });
        logger.info(`🔗 Link público creado para ${caso.ticketNumber}.`);
      }
      return res.json({ codigo, ruta: `/estado/${codigo}` });
    } catch (err) {
      logger.error(err);
      return res.status(500).json({ error: 'Error creando el link' });
    }
  });

  app.delete('/api/supports/:id/link-publico', async (req, res) => {
    try {
      const caso = await prisma.supportCase.findUnique({
        where: { id: String(req.params.id) },
        select: { updatedAt: true },
      });
      if (!caso) return res.status(404).json({ error: 'Ticket no encontrado' });
      await prisma.supportCase.update({
        where: { id: String(req.params.id) },
        // Igual que al crearlo: quitar el link no mueve la fecha del caso.
        data: { publicToken: null, updatedAt: caso.updatedAt },
      });
      logger.info(`🔗 Link público revocado (${req.params.id}).`);
      return res.json({ ok: true });
    } catch (err) {
      logger.error(err);
      return res.status(500).json({ error: 'Error revocando el link' });
    }
  });

  app.get('/api/export/csv', async (req, res) => {
    try {
      const cases = await getSupports(filtersFrom(req.query));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="soportes-${stamp()}.csv"`);
      res.send(toCSV(cases));
    } catch (err) {
      logger.error(err);
      res.status(500).json({ error: 'Error generando el CSV' });
    }
  });

  app.get('/api/export/excel', async (req, res) => {
    try {
      const cases = await getSupports(filtersFrom(req.query));
      const buffer = await toExcel(cases);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader('Content-Disposition', `attachment; filename="soportes-${stamp()}.xlsx"`);
      res.send(buffer);
    } catch (err) {
      logger.error(err);
      res.status(500).json({ error: 'Error generando el Excel' });
    }
  });

  app.get('/api/export/pdf', async (req, res) => {
    try {
      const cases = await getSupports(filtersFrom(req.query));
      const buffer = await toPDF(cases);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="soportes-${stamp()}.pdf"`);
      res.send(buffer);
    } catch (err) {
      logger.error(err);
      res.status(500).json({ error: 'Error generando el PDF' });
    }
  });

  // Red de seguridad: cualquier error no atrapado devuelve JSON, no un crash.
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error(err);
    res.status(500).json({ error: 'Error interno del servidor' });
  });

  app.listen(env.PORT, () => {
    logger.info(`📊 Dashboard disponible en http://localhost:${env.PORT}`);
    if (authEnabled()) {
      logger.info(`🔒 Acceso protegido — usuario: ${env.DASHBOARD_USER}`);
      if (!env.DASHBOARD_PASS_HASH) {
        logger.warn('⚠️  La contraseña está en texto plano. Genera un hash con: npm run pass');
      }
    } else {
      logger.warn('⚠️  Dashboard SIN contraseña. Configura DASHBOARD_USER en .env');
    }
  });
}
