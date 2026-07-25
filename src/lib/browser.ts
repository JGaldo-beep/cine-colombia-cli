// Handing a URL to the user's default browser.

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

  try {
    const proc = Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' });
    // `start` and `open` exit as soon as the browser is handed the URL.
    return (await proc.exited) === 0;
  } catch (error) {
    logger.debug('No se pudo abrir el navegador:', error);
    return false;
  }
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
