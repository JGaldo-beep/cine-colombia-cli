#!/usr/bin/env bun
// Cine Colombia CLI entrypoint.

import { Command } from 'commander';
import pc from 'picocolors';
import { asientos } from '../src/commands/asientos.js';
import { cartelera } from '../src/commands/cartelera.js';
import { comprar } from '../src/commands/comprar.js';
import { confiteria } from '../src/commands/confiteria.js';
import { horarios } from '../src/commands/horarios.js';
import { cuenta, login, logout } from '../src/commands/login.js';
import { pelicula } from '../src/commands/pelicula.js';
import { teatros } from '../src/commands/teatros.js';
import { APP_DESCRIPTION, APP_VERSION } from '../src/config/constants.js';
import { CineError } from '../src/lib/errors.js';
import { LogLevel, logger } from '../src/lib/logger.js';

const program = new Command();

program
  .name('cine')
  .description(APP_DESCRIPTION)
  .version(APP_VERSION)
  .option('-v, --verbose', 'mostrar detalle de red y caché')
  .showHelpAfterError()
  // Applies before any subcommand action runs.
  .hook('preAction', (command) => {
    if (command.opts().verbose) logger.setLevel(LogLevel.DEBUG);
  });

program
  .command('cartelera')
  .alias('films')
  .description('Ver las películas en cartelera')
  .option('-c, --ciudad <ciudad>', 'solo películas con funciones en esa ciudad')
  .option('-g, --genero <genero>', 'filtrar por género')
  .option('-b, --buscar <texto>', 'filtrar por título')
  .option('--refrescar', 'ignorar la caché y consultar de nuevo')
  .option('--json', 'salida en JSON')
  .action(cartelera);

program
  .command('pelicula')
  .alias('film')
  .description('Ver el detalle de una película')
  .argument('<busqueda>', 'título o ID de la película')
  .option('--refrescar', 'ignorar la caché y consultar de nuevo')
  .option('--json', 'salida en JSON')
  .action(pelicula);

program
  .command('teatros')
  .alias('cines')
  .description('Ver los teatros de Cine Colombia')
  .option('-c, --ciudad <ciudad>', 'filtrar por ciudad')
  .option('-b, --buscar <texto>', 'filtrar por nombre')
  .option('--cerca <lat,lng>', 'ordenar por cercanía a una coordenada')
  .option('--todos', 'incluir puntos que no venden boletas')
  .option('--refrescar', 'ignorar la caché y consultar de nuevo')
  .option('--json', 'salida en JSON')
  .action(teatros);

program
  .command('asientos')
  .alias('seats')
  .description('Ver el mapa de sillas de una función')
  .argument('<funcion>', 'ID de la función, por ejemplo 6493-7850')
  .option('-l, --lista', 'solo listar sillas libres, sin dibujar el mapa')
  .option('-p, --precios', 'incluir tipos de boleta y precios')
  .option('--plain', 'sin colores, para pipes y terminales simples')
  .option('--refrescar', 'ignorar la caché y consultar de nuevo')
  .option('--json', 'salida en JSON')
  .action(asientos);

program
  .command('login')
  .description('Vincular tu cuenta de Cine Colombia (abre el navegador)')
  // Commander maps `--no-recordar` to `recordar: false`, so the default is on.
  .option('--no-recordar', 'sesión corta: no marcar "Mantenerme registrado"')
  .option('--json', 'salida en JSON')
  .action(login);

program.command('logout').description('Cerrar la sesión guardada').action(logout);

program
  .command('cuenta')
  .alias('account')
  .description('Ver tu cuenta y tus boletas activas')
  .option('--json', 'salida en JSON')
  .action(cuenta);

program
  .command('confiteria')
  .alias('snacks')
  .description('Ver la confitería de un teatro')
  .argument('<teatro>', 'nombre o ID del teatro')
  .option('-m, --menu <seccion>', 'ver otra sección, por ejemplo sushi')
  .option('-b, --buscar <texto>', 'filtrar productos por nombre')
  .option('--todo', 'ver todas las secciones')
  .option('--refrescar', 'ignorar la caché')
  .option('--json', 'salida en JSON')
  .action(confiteria);

program
  .command('comprar')
  .alias('buy')
  .description('Comprar boletas: elige sillas y genera el enlace de pago')
  .argument('<funcion>', 'ID de la función, por ejemplo 6493-7850')
  .option('-s, --sillas <sillas>', 'sillas a comprar, por ejemplo "A5,A6"')
  .option('-b, --boleta <id>', 'forzar un tipo de boleta para todas las sillas')
  .option('--nombre <nombre>', 'nombre del comprador')
  .option('--apellido <apellido>', 'apellido del comprador')
  .option('--email <email>', 'correo del comprador')
  .option('--cedula <cedula>', 'número de identificación')
  .option('--dry-run', 'mostrar todo sin crear la orden ni apartar sillas')
  .option('--si', 'no pedir confirmación antes de apartar las sillas')
  .option('--sin-abrir', 'solo imprimir el enlace de pago, sin abrir el navegador')
  .option('--plain', 'sin colores')
  .action(comprar);

program
  .command('horarios')
  .alias('showtimes')
  .description('Ver los horarios de una película')
  .argument('<busqueda>', 'título o ID de la película')
  .option('-c, --ciudad <ciudad>', 'ciudad a consultar (por defecto Bogotá)')
  .option('-t, --teatro <teatro>', 'un solo teatro, por nombre o ID')
  .option('-f, --fecha <DD-MM-YYYY>', 'fecha a consultar, por ejemplo 24-07-2026')
  .option('--refrescar', 'ignorar la caché y consultar de nuevo')
  .option('--json', 'salida en JSON')
  .action(horarios);

try {
  await program.parseAsync();
} catch (error) {
  // Our own errors carry a message written for the user; anything else is a bug
  // and deserves a stack trace.
  if (error instanceof CineError) {
    console.error(`\n${pc.red('✗')} ${error.message}\n`);
    logger.debug('Detalle:', error.details);
  } else {
    console.error(`\n${pc.red('✗')} Error inesperado:`, error);
  }
  process.exitCode = 1;
}
