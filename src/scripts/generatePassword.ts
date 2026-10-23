// ============================================================
//  Genera el hash de una contraseña para el dashboard.
//  Uso:  npm run pass -- MiContraseñaSegura
//  o solo: npm run pass    (y la pide de forma interactiva)
// ============================================================
import readline from 'node:readline';
import { hashPassword } from '../api/auth.js';

function evaluarFuerza(p: string): string[] {
  const avisos: string[] = [];
  if (p.length < 10) avisos.push('Usa al menos 10 caracteres.');
  if (!/[A-Z]/.test(p)) avisos.push('Agrega alguna MAYÚSCULA.');
  if (!/[a-z]/.test(p)) avisos.push('Agrega alguna minúscula.');
  if (!/[0-9]/.test(p)) avisos.push('Agrega algún número.');
  if (!/[^A-Za-z0-9]/.test(p)) avisos.push('Agrega algún símbolo (! @ # $ ...).');
  if (/^(1q2w|qwer|asdf|1234|abcd|password|contrasena)/i.test(p)) {
    avisos.push('Evita secuencias del teclado o palabras comunes.');
  }
  return avisos;
}

function mostrar(pass: string): void {
  const avisos = evaluarFuerza(pass);

  console.log('\n' + '─'.repeat(64));
  if (avisos.length) {
    console.log('⚠️  Esta contraseña se puede mejorar:');
    for (const a of avisos) console.log('   • ' + a);
  } else {
    console.log('✅ Contraseña fuerte.');
  }

  console.log('\n📋 Copia estas líneas en tu archivo .env');
  console.log('   (y BORRA la línea vieja de DASHBOARD_PASS):\n');
  console.log('DASHBOARD_PASS_HASH=' + hashPassword(pass));
  console.log('\n' + '─'.repeat(64));
  console.log('Guarda tu contraseña en un lugar seguro: el hash NO se puede revertir.\n');
}

const desdeArgumento = process.argv.slice(2).join(' ').trim();

if (desdeArgumento) {
  mostrar(desdeArgumento);
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Escribe la contraseña que quieres usar: ', (respuesta) => {
    rl.close();
    const pass = respuesta.trim();
    if (!pass) {
      console.error('\n❌ No escribiste nada. Intenta de nuevo.\n');
      process.exit(1);
    }
    mostrar(pass);
  });
}
