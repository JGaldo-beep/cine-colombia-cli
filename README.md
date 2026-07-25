# cine-colombia-cli

Cartelera, teatros, horarios, mapa de sillas y compra de boletas de **Cine Colombia**
desde la terminal. Incluye un **servidor MCP** para usarlo conversacionalmente con
Claude o cualquier agente de IA.

```
          P A N T A L L A
───────────────────────────────────

    GENERAL (80 libres)
   A ○ ○ ○ ○ ○ ○ ○ ○     ○ ○ ○ ○ ○ ○ ○ ○
   B ● ● ● ● ● ● ● ●     ○ ● ● ○ ● ●

    PREFERENCIAL (22 libres)
   F   ○ ○ ○ ○ ○   × × × × × ×

  ○ libre   ● ocupada   × fuera de servicio
```

## Instalación

Requiere [Bun](https://bun.sh) 1.2+.

```bash
git clone https://github.com/JGaldo-beep/cine-colombia-cli.git
cd cine-colombia-cli
bun install
```

Consultar la cartelera, los horarios, las sillas y comprar como invitado funciona solo
con eso. **`cine login` necesita además Node.js** en el PATH, porque el paso del
navegador corre en un subproceso Node: `chromium.launch()` de Playwright nunca retorna
bajo Bun en Windows. Sin Node, el resto de la CLI funciona igual y solo `login` avisa
que falta.

Opcional, para dejarlo como comando global:

```bash
bun link
cine cartelera
```

Sin `bun link`, todos los ejemplos funcionan con `bun run bin/cine.ts <comando>`.

## Uso

### Cartelera

```bash
cine cartelera                        # todas las películas listadas
cine cartelera --ciudad bogota        # solo las que tienen funciones hoy
cine cartelera --genero terror -c cali
```

Sin `--ciudad` lista el catálogo completo, que incluye preventas y estrenos futuros.
Con `--ciudad` se cruza contra los horarios reales, así que la respuesta pasa de
"qué existe" a "qué puedo ver hoy", con el número de funciones por película.

### Detalle de una película

```bash
cine pelicula odisea
cine pelicula HO00000386
```

La búsqueda ignora acentos y mayúsculas, y prioriza coincidencias exactas.

### Teatros

```bash
cine teatros                             # agrupados por ciudad
cine teatros --ciudad medellin
cine teatros --cerca "4.6533,-74.0836"   # ordenados por distancia
```

50 sedes en 17 ciudades, 49 con coordenadas. Por defecto oculta los puntos que no
venden boletas; `--todos` los incluye.

### Horarios

```bash
cine horarios odisea                     # Bogotá por defecto
cine horarios odisea --teatro andino
cine horarios odisea --fecha 25-07-2026
```

Las fechas se escriben en **DD-MM-YYYY**. Sin `--fecha` consulta la próxima fecha con
funciones, lo que evita respuestas vacías cuando la película no está en función hoy.

### Mapa de sillas

```bash
cine asientos 6493-7850            # dibuja la sala
cine asientos 6493-7850 --precios  # con tipos de boleta y precios
cine asientos 6493-7850 --lista    # solo el listado de sillas libres
```

Los huecos del mapa son pasillos reales: las sillas se ubican por su coordenada de
grilla, no por su etiqueta, porque no coinciden (la silla `A16` está en la columna 18).

El mapa se dibuja con la misma orientación que usa Cine Colombia: la fila A junto a la
pantalla, y **la silla 1 a la derecha**, contando hacia la izquierda. En la API el
`columnIndex` crece con el número de silla, así que dibujarlo de izquierda a derecha
espejaba la sala y mandaba a la persona al lado equivocado. Verificado contra la web con
la función `6493-7806`, comparando fila por fila qué sillas estaban ocupadas.

### Confitería

```bash
cine confiteria andino             # crispetas, bebidas y combos
cine confiteria andino --menu sushi
cine confiteria andino --todo
```

Las secciones son las del propio teatro (`Confiteria`, `Sushi`, `Cinepolitana`,
`Juan Valdez`), no una lista de productos escrita a mano.

### Cuenta

```bash
cine login                  # abre el navegador para que inicies sesión
cine login --no-recordar    # sesión corta (30 min) en una máquina compartida
cine cuenta                 # tu perfil, tus boletas activas y cuándo vence la sesión
cine logout
```

El login de Cine Colombia está protegido por reCAPTCHA, así que **ninguna CLI puede
autenticarse enviando credenciales** — para eso existe reCAPTCHA. `cine login` abre un
navegador real, iniciás sesión vos, y la CLI guarda únicamente la cookie de sesión.
**Tu contraseña nunca pasa por esta CLI**: la captura arranca después del login.

El navegador corre en un subproceso de Node, no en Bun: `chromium.launch()` de
Playwright nunca retorna bajo Bun en Windows, así que el paso del navegador vive en
`scripts/capture-session.mjs`.

**Cuánto dura la sesión.** `cine login` marca "Mantenerme registrado" por defecto, lo
que cambia lo que la cookie declara: sin marcar dice `isPersistent: false` y expira en
30 minutos, marcada dice `isPersistent: true` y declara 30 días. `--no-recordar` la
deja corta a propósito.

Pero **ese campo no es la validez real**: solo dice cuánto guarda la cookie el
navegador. El servidor invalida el token cifrado que va dentro muchísimo antes.
Medido dos veces, con sondas cada 5 minutos: una sesión con 30 días declarados murió
**entre los 15 y los 20 minutos**, y otra ya estaba muerta a los 48. Usarla no la
mantiene viva.

En la práctica eso significa que marcar la casilla **no alarga la sesión**: cambia lo
que la cookie declara, no lo que el servidor respeta. Se deja marcada porque es lo que
haría cualquier persona, pero no esperes que sirva de nada.

Cuando expira, la CLI lo dice ("Tu sesión expiró") en vez de fallar con un 403 crudo,
y hay que volver a correr `cine login`. No hay renovación automática posible: al
expirar, el propio sitio deja de reconocer al navegador incluso con el perfil
guardado, así que no queda nada que refrescar sin escribir la contraseña otra vez.

**Consecuencia práctica**: si vas a usar `cine cuenta` o comprar con tu cuenta,
ejecutá `cine login` justo antes. Comprar como invitado no necesita sesión.

Con la sesión vinculada, `cine comprar` completa tus datos solo (nombre, correo y
cédula salen de tu cuenta) y no hay que guardar nada a mano.

### Comprar boletas

```bash
cine comprar 6493-7850                          # interactivo
cine comprar 6493-7850 --sillas "A5,A6"
cine comprar 6493-7850 --sillas A5 --dry-run    # ver todo sin apartar nada
```

Sin sesión funciona igual como invitado, pidiendo nombre, apellido, correo y cédula
(o por bandera: `--nombre`, `--apellido`, `--email`, `--cedula`).

**Hasta dónde llega y por qué.** La CLI hace todo: elegir sillas, tipo de boleta,
datos del comprador, crear la orden y **generar el enlace de pago**. Lo único que pasa
al navegador es teclear la tarjeta, porque Cine Colombia redirige a **PlacetoPay**, una
pasarela alojada PCI que hace fingerprinting del dispositivo justamente para detectar
automatización. Automatizarla implicaría manejar datos de tarjeta y saltarse un control
antifraude.

Salvaguardas, porque apartar sillas afecta a otros clientes:

- Confirmación explícita antes de crear la orden (`--si` para omitirla)
- `--dry-run` se detiene antes de crear la orden y no aparta ninguna silla
- Los datos del comprador se validan **antes** de tocar la API
- Si algo falla o cancelás con Ctrl+C, la orden se borra y las sillas se liberan
- Una vez generado el enlace de pago la orden ya no se cancela: vas a pagar

### Opciones comunes

| Opción | Efecto |
|---|---|
| `--json` | salida en JSON, para combinar con `jq` |
| `--refrescar` | ignora la caché y consulta de nuevo |
| `-v, --verbose` | muestra el detalle de red, token y caché |

## Servidor MCP

El servidor expone las mismas capacidades como herramientas MCP, para manejar todo
conversacionalmente ("¿qué dan hoy en el Andino?", "muéstrame las sillas libres").

```bash
bun run mcp
```

### Claude Desktop

Agregá esto a tu `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "cine-colombia": {
      "command": "bun",
      "args": ["run", "/ruta/absoluta/a/cine-colombia-cli/src/mcp/server.ts"]
    }
  }
}
```

Reiniciá Claude Desktop y las herramientas aparecen disponibles.

### Claude Code

**No hace falta configurar nada.** El repo trae un `.mcp.json` con alcance de proyecto,
así que basta con entrar y abrir Claude:

```bash
cd cine-colombia-cli
bun install
claude
```

La primera vez Claude pide aprobar el servidor del proyecto, porque ejecutar un
comando declarado en un repo ajeno es una decisión del usuario y no del repo. Después
de aceptar, las diez herramientas quedan disponibles y ya se puede preguntar "¿qué dan
hoy en el Andino?".

El `.mcp.json` es deliberadamente portable: invoca `bun` del PATH y una ruta relativa,
sin nada atado a una máquina concreta.

```json
{
  "mcpServers": {
    "cine-colombia": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "src/mcp/server.ts"]
    }
  }
}
```

Para comprobar que quedó conectado:

```bash
claude mcp list
```

### Otros agentes (Cursor, Windsurf, Continue, opencode)

Cualquier cliente MCP por stdio sirve con la misma forma: comando `bun`, argumentos
`run <ruta>/src/mcp/server.ts`. En `opencode`, por ejemplo:

```json
{
  "mcp": {
    "cine-colombia": {
      "type": "local",
      "command": ["bun", "run", "/ruta/absoluta/a/cine-colombia-cli/src/mcp/server.ts"]
    }
  }
}
```

### Herramientas disponibles

| Herramienta | Qué hace |
|---|---|
| `ver_cartelera` | Películas en cartelera, opcionalmente por ciudad y género |
| `ver_pelicula` | Sinopsis, duración, clasificación, reparto, tráiler |
| `ver_teatros` | Teatros con dirección, y orden por cercanía a una coordenada |
| `ver_horarios` | Funciones de una película, con sus IDs |
| `ver_asientos` | Sillas libres y ocupadas, con precios |
| `ver_confiteria` | Menú del teatro |
| `ver_cuenta` | Cuenta vinculada y boletas activas |
| `cotizar_compra` | Calcula el precio **sin apartar nada** |
| `crear_orden` | Aparta sillas reales y devuelve el enlace de pago |
| `cancelar_orden` | Libera las sillas de una orden sin pagar |

La separación entre `cotizar_compra` y `crear_orden` es intencional: la primera es de
solo lectura y se puede llamar libremente, la segunda aparta sillas reales y **exige
`confirmar: true`**. Esa restricción está en el código, no en el prompt, porque pedirle
a un modelo que confirme antes es una sugerencia, no una garantía.

Para comprar desde el agente hay que iniciar sesión una vez con `cine login` en la
terminal, ya que el reCAPTCHA necesita una persona.

## Cómo funciona

Cine Colombia corre sobre **Vista Cinema (OCAPI)**. La CLI no scrapea HTML: usa la
misma API JSON que consume la web, en `digital-api.cinecolombia.com`.

Esa API pide un JWT que el sitio embebe en el HTML que sirve al navegador
(`{"api":{"apiUrl":...,"authToken":"..."}}`) y que vive unas 12 horas. La CLI lo extrae
una vez, lo guarda en `data/.auth-token.json` con permisos `0600` y lo renueva solo
cuando está por vencer. Las respuestas se cachean en disco con TTL por tipo de dato,
así que una consulta repetida baja de ~3s a ~0.5s.

La disponibilidad de sillas se cachea solo 1 minuto: mostrar como libre una silla ya
vendida manda a alguien a la silla equivocada.

### El flujo de compra

El checkout de la web vive en `multiplex.cinecolombia.com` (Next.js) pero consume la
misma OCAPI, y su URL contiene el mismo ID de función que devuelve esta CLI. La
secuencia, derivada grabando el checkout real:

| Llamada | Efecto |
|---|---|
| `POST /ocapi/v1/orders/standard/booking` | crea la orden vacía |
| `PUT /orders/{id}/showtimes/{showtimeId}` | asigna sillas y boletas — **aquí se apartan** |
| `PUT /orders/{id}/customer` | datos del comprador |
| `POST /orders/{id}/payments/redirect` | devuelve la URL de pago |
| `DELETE /orders/{id}` | libera las sillas |

Dos cosas verificadas contra la API en vivo:

- **La API valida la combinación silla/boleta** y responde 400 si el tipo no corresponde
  al área. OCAPI no publica ese mapeo (`ticketPrices` no trae `areaCategoryId`, y varios
  tipos reportan `isDefault` porque el default es *por área*), así que la CLI lo infiere
  por nombre y deja que la API sea la autoridad.
- **La identidad de la cuenta viaja en una cookie**, no en el token. El JWT del checkout
  no tiene ningún claim de usuario; enviar la cookie
  `vista-loyalty-member-authentication-token` es lo que convierte un 401 en 200 en
  `GET /ocapi/v1/members/current`.
- **`seat-availability` es eventualmente consistente**, con uno o dos segundos de
  retraso, y forzar el refresco no ayuda porque el retraso es del servidor. Medido
  alrededor de una reserva real: la silla seguía reportándose libre a los 12 ms y
  aparecía tomada a los ~1,8 s; al cancelar volvió a libre en pocos segundos. Por eso
  **no sirve para confirmar que una orden se creó o que una cancelación liberó las
  sillas** — los endpoints de la orden son la autoridad. Una lectura inmediatamente
  después de escribir contradice a la escritura.

La URL que devuelve `payments/redirect` es la pasarela de Vista
(`cineco-wpm.app.vista.co/Request.aspx?token=...`), que a su vez lleva a PlacetoPay.

### La parte incómoda: Cloudflare

`www.cinecolombia.com` está detrás de Cloudflare, y solo la obtención del token lo
atraviesa (el host de la API no está protegido). Cloudflare ahí discrimina por el
**nombre crudo de los headers HTTP/1.1**, algo verificado de forma repetible contra el
sitio en vivo:

| Request | Resultado |
|---|---|
| `User-Agent: <chrome>` | 200 + token |
| `user-agent: <chrome>` | 403 challenge |
| sin user agent | 403 challenge |
| se agrega `Accept: text/html,...` | 403 challenge |

Dos consecuencias que están documentadas en el código y **no hay que "limpiar"**:

1. El `fetch` del runtime no puede servir para esto: la spec de `Headers` obliga a pasar
   los nombres a minúsculas, así que es incapaz de mandar `User-Agent`. Por eso la
   estrategia principal es un subproceso `curl`, que sí preserva el casing.
2. No se manda `Accept`. Un `Accept` de navegador desde un cliente que no lo es se
   interpreta como incoherencia y se castiga con challenge.

Si ambas estrategias fallan, la CLI lo dice explícitamente. `CINE_FETCH_STRATEGY=fetch,curl`
permite forzar el orden.

## Desarrollo

```bash
bun test              # 159 tests, sin red
bun run type-check    # tsc --noEmit
bun run lint          # biome
bun run smoke         # verificación end-to-end contra la API real
```

Los tests son deterministas y no tocan la red. `smoke` sí consulta la API en vivo y es
la forma de detectar que Cine Colombia cambió algo.

## Estructura

```
bin/cine.ts                          entrypoint (commander)
src/commands/                        cartelera, pelicula, teatros, horarios,
                                     asientos, comprar, confiteria, login
src/mcp/server.ts                    servidor MCP (stdio)
src/services/api/ocapi-client.ts     cliente HTTP + caché
src/services/api/order-service.ts    ciclo de vida de la orden
src/services/api/mappers.ts          formato OCAPI -> modelo de dominio
src/services/auth/token-provider.ts  obtención y caché del JWT
src/services/auth/html-fetcher.ts    estrategias de descarga (curl, fetch)
src/services/auth/member-session.ts  sesión de cuenta (cookie)
src/services/auth/session-capture.ts frontera con el navegador de login
scripts/capture-session.mjs          paso del navegador (Node, Playwright)
scripts/remember-me.mjs              marca "Mantenerme registrado"
src/services/cache/cache-manager.ts  caché en disco con TTL
src/lib/                             formato, búsqueda, mapa de sillas, booking,
                                     navegador, errores, logger, banner
src/types/                           tipos crudos (OCAPI) y de dominio
```

## Limitaciones conocidas

- **El pago se completa en el navegador.** PlacetoPay es una pasarela PCI con
  fingerprinting antifraude; automatizarla no es viable ni apropiado.
- **El login requiere una persona** por el reCAPTCHA, y **la sesión es corta**. La cookie
  declara 30 días pero el servidor la invalida en 15-20 minutos (medido), así que
  hay que volver a correr `cine login` cada tanto. No se renueva sola, y no por falta de
  intentarlo: cuando la sesión muere, el sitio deja de reconocer al navegador incluso con
  el perfil guardado, así que no hay nada que refrescar. La CLI al menos lo dice claro en
  vez de fallar con un 403 crudo.
- La API es interna y sin versionar: puede cambiar sin avisar. `bun run smoke` es el canario.
- La confitería se puede consultar, pero todavía no se agrega a la orden.

## Privacidad

- El token de la API y la cookie de sesión se guardan en `data/` con permisos `0600` y
  están en `.gitignore`. Son credenciales: no los compartas.
- La contraseña de tu cuenta nunca es leída, almacenada ni transmitida por esta CLI.
- `cine logout` borra la sesión guardada **y el perfil del navegador** (`data/chrome-profile`).
  Ambos hacen falta: Chrome persiste la misma cookie en su perfil, así que borrar solo la
  copia de la CLI dejaría una credencial usable en disco.

## Licencia

MIT

## Aviso

Proyecto personal, sin relación con Cine Colombia S.A. Usa endpoints internos no
documentados y puede dejar de funcionar en cualquier momento. Usalo de forma
responsable y respetando los términos del servicio.
