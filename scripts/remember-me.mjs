// Ticks "Mantenerme registrado" on the sign-in form.
//
// This is not cosmetic. The session cookie carries its own lifetime and the server
// decides it from this checkbox. Measured against the live site by decoding the
// cookie, which is URL-encoded JSON:
//
//   unticked -> {"isPersistent":false, "ExpiryDate": +30 minutes}
//   ticked   -> {"isPersistent":true,  "ExpiryDate": +30 days}
//
// Thirty minutes is shorter than the task it is meant to support, so the CLI opts
// in by default and `cine login --no-recordar` opts out.
//
// Why clicking the label rather than the input: the real input is styled invisible
// (`opacity: 0`) with the visible control drawn by sibling divs, and it carries no
// `id`/`for` pairing — it is wrapped by its label instead. So Playwright's `check()`
// rejects it as hidden, and `label[for=...]` matches nothing. Clicking the
// enclosing label is what a person actually does and toggles it natively.

const INPUT_SELECTOR = 'input[name="remember"]';
const LABEL_SELECTOR = 'label:has(input[name="remember"])';

/**
 * @returns {Promise<'ticked' | 'already' | 'unavailable'>}
 */
export async function tickRememberMe(page, { timeoutMs = 15000, log = () => {} } = {}) {
  let input;
  try {
    input = page.locator(INPUT_SELECTOR).first();
    await input.waitFor({ state: 'attached', timeout: timeoutMs });
  } catch {
    log('  Nota: no se encontró "Mantenerme registrado"; márcalo tú para que la sesión dure.\n');
    return 'unavailable';
  }

  if (await input.isChecked().catch(() => false)) return 'already';

  // Clicking the wrapping label is the faithful path; force-clicking the hidden
  // input is the fallback for a restyled form.
  const attempts = [
    () => page.locator(LABEL_SELECTOR).first().click({ timeout: 5000 }),
    () => input.check({ force: true, timeout: 5000 }),
  ];

  for (const attempt of attempts) {
    try {
      await attempt();
      if (await input.isChecked().catch(() => false)) {
        log('  Sesión persistente activada ("Mantenerme registrado").\n');
        return 'ticked';
      }
    } catch {
      // Try the next strategy.
    }
  }

  log('  Nota: no se pudo activar "Mantenerme registrado"; márcalo tú para que la sesión dure.\n');
  return 'unavailable';
}
