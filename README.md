# Support Tracker AI

**Bot de WhatsApp + dashboard web que detecta solicitudes de soporte con IA y las registra con evidencia.**

> Versión pública del proyecto que corre en producción en una empresa de soporte de TI.
> Los nombres de clientes, técnicos y teléfonos se reemplazaron por datos de ejemplo.

---

## El problema

En una empresa de soporte de TI, casi todo el trabajo llega por grupos de WhatsApp de los
clientes. Ese trabajo no quedaba registrado en ningún lado, y al final del mes era difícil
demostrarle al cliente todo lo que se había hecho por él.

## La solución

Un bot que **escucha** los grupos de WhatsApp (nunca contesta en ellos), usa IA para
detectar qué mensajes son solicitudes de soporte y los convierte en **tickets con evidencia**.
Encima, un dashboard web para el equipo y un reporte mensual en PDF para cada cliente.

## Qué hace

- **Detección con IA:** clasifica cada mensaje (categoría, severidad, sitio) y agrupa la
  conversación en un solo caso. Soporta **5 proveedores de IA** intercambiables
  (Groq, Claude, OpenAI, Gemini, DeepSeek) con una sola variable de entorno.
- **La IA propone, la persona decide:** si alguien edita un ticket a mano, la IA ya no lo
  sobrescribe.
- **Tickets con evidencia:** guarda los mensajes y las fotos de WhatsApp ligados a cada caso.
- **Reparto automático:** asigna cada soporte al técnico con menos carga y respeta quién está
  ausente.
- **Comandos de WhatsApp** para el equipo interno: cerrar tickets, marcar ausencias, enviar
  reportes.
- **Reporte mensual en PDF** por cliente, que solo se envía cuando un humano lo autoriza.
- **Alertas de monitoreo:** recibe alertas de Zabbix (por ejemplo, cortes de luz) y avisa por
  WhatsApp.
- **Dashboard web** con login seguro (contraseñas con scrypt, cookie de sesión y límite de
  intentos), estadísticas y exportación a Excel.

## Stack

| Capa | Tecnología |
|---|---|
| Lenguaje | TypeScript (Node.js) |
| WhatsApp | Baileys |
| Base de datos | Prisma + SQLite |
| API y dashboard | Express + HTML/CSS/JavaScript |
| IA | Groq, Claude, OpenAI, Gemini, DeepSeek (capa de proveedores intercambiables) |
| Reportes | PDFKit, ExcelJS |
| Validación | Zod |
| Despliegue | Windows Server, tarea programada, Git/GitHub |

## Arquitectura

```
WhatsApp → socket → messageHandler → servicios + IA → Prisma (SQLite)
Dashboard → API REST (Express) → servicios → Prisma
```

Organizado por capas: `ai/` (proveedores y prompt), `services/` (lógica: tickets, reparto,
estadísticas, reportes), `whatsapp/` (conexión y comandos), `api/` (dashboard).

## En números

- ~8,300 líneas de TypeScript
- En producción desde septiembre de 2026, en un servidor Windows de la empresa
- Usado a diario por el equipo de soporte

## Cómo lo construí

Lo desarrollé **apoyándome en IA (Claude)** como asistente de programación: yo definí el
problema, el diseño y las reglas del negocio, depuré los bugs en producción y lo desplegué.
Aprendí sobre la marcha arquitectura por capas, bases de datos con ORM, seguridad básica
de aplicaciones web y despliegue.

## Cómo correrlo

```bash
npm install
cp .env.example .env      # agrega la llave del proveedor de IA que uses
npm run db:push           # crea la base SQLite
npm run dashboard         # solo el dashboard en http://localhost:3000
npm run dev               # bot + dashboard (muestra un QR para vincular WhatsApp)
```

Los clientes y el equipo de ejemplo se configuran en `src/config/companies.ts` y
`src/config/technicians.ts`.

## Capturas

<!-- Agregar 3 o 4 capturas del dashboard con los nombres de clientes tapados -->
