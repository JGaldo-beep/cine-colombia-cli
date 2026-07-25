// Handing a URL to the user's default browser.

import { spawn } from 'node:child_process';
import { logger } from './logger.js';

/**
 * Open a URL in the default browser.
 *
 * Never throws: the URL is always printed by the caller as well, so a headless
 * box or an unusual desktop environment degrades to copy-and-paste instead of
 * failing a purchase that is otherwise complete.
 *
 * @returns true when the platform command was launched successfully.
 */
export async function openInBrowser(url: string): Promise<boolean> {
  // Refuse anything that is not http(s): this URL ends up in a shell command.
  if (!/^https?:\/\//i.test(url)) {
    logger.debug('Se rechazó abrir una URL que no es http(s):', url);
    return false;
  }

  const command = commandFor(url);
  if (!command) return false;

  // `node:child_process` y no `Bun.spawn`: el build publicado corre bajo Node puro.
  return new Promise((resolve) => {
    try {
      const [file, ...args] = command;
      const child = spawn(file as string, args, { stdio: 'ignore' });
      child.on('error', (error) => {
        logger.debug('No se pudo abrir el navegador:', error);
        resolve(false);
      });
      // `start` y `open` terminan en cuanto le pasan la URL al navegador.
      child.on('close', (code) => resolve(code === 0));
    } catch (error) {
      logger.debug('No se pudo abrir el navegador:', error);
      resolve(false);
    }
  });
}

function commandFor(url: string): string[] | null {
  switch (process.platform) {
    case 'win32':
      // The empty string is `start`'s window-title argument. Without it, a URL
      // containing characters cmd treats specially can be read as a title.
      return ['cmd', '/c', 'start', '', url];
    case 'darwin':
      return ['open', url];
    case 'linux':
      return ['xdg-open', url];
    default:
      logger.debug(`Plataforma sin soporte para abrir el navegador: ${process.platform}`);
      return null;
  }
}
