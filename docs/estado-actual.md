# Ronda — qué hay construido

Estado al 27 de septiembre de 2026. El código está en `main` (`7c3c42c`); el nuevo diseño de la app
del comensal está en la rama `restyle-diner` (`9e8051e`), listo para subir.

## Qué es

Una cuenta compartida para bares y gastrobares. Varias personas en la misma mesa escanean un QR,
piden desde su celular a un carrito común y pagan cada una su parte con Wompi (tarjeta, Nequi,
PSE). Nadie descarga nada ni crea una cuenta: basta un apodo.

Como la plata que se paga por Wompi no se devuelve sola, el sistema está hecho para que sea
**imposible cobrar de más**, en vez de corregirlo después.

## Los tres modos de cobro

Cada restaurante elige uno. Una mesa conserva el modo con que se abrió aunque el restaurante lo
cambie después.

| Modo | Cómo funciona |
|---|---|
| **Pagar antes de pedir** | Cada ronda se paga completa antes de que la cocina la reciba. |
| **Cuenta abierta** | Las rondas van a la cocina sin cobrar; se paga todo al final, al pedir la cuenta. |
| **Híbrido** | La primera ronda se paga antes; las siguientes se descuentan del saldo a favor de la mesa, y si no alcanza, se cobran. |

## Una noche en la mesa, de punta a punta

1. **Entrar.** El comensal escanea el QR de la mesa y escribe un apodo.
2. **Pedir.** Todos agregan platos al mismo carrito, desde su celular. Un plato se puede
   compartir entre varias personas; cada una ve cuánto le toca.
3. **Cerrar la ronda.** El carrito se congela. Lo que se pida después va a una ronda nueva.
4. **Pagar la ronda** (en "pagar antes de pedir"). Cada persona paga lo suyo ("Pagar lo mío") o
   alguien cubre lo que falta ("Cubrir el resto"). Lo que se paga queda apartado 5 minutos para
   esa persona, así dos personas nunca pagan lo mismo.
5. **Cocina.** Cuando la ronda está pagada completa, llega sola a la pantalla de la cocina. La
   cocina la marca "Listo" cuando sale.
6. **Pedir la cuenta.** Al final, cualquier comensal (o el mesero) pide la cuenta. Desde ese
   momento no se puede pedir más.
7. **Pagar la cuenta** (en "cuenta abierta"). Cada persona paga **todo lo suyo de todas las rondas
   en un solo pago**, o alguien cubre el resto de la mesa.
8. **La mesa se cierra sola** cuando ya no queda nada por pagar. El siguiente grupo que escanee
   el QR abre una mesa nueva.

## Cómo llega un pago

Un pago de Wompi entra por el primero de tres caminos que lo encuentre, y nunca se cuenta dos
veces:

- **El aviso de Wompi** (webhook), en segundos.
- **Al volver a la mesa:** Wompi devuelve al comensal a su mesa y la página confirma el pago al
  instante.
- **La revisión automática:** cada minuto el servidor le pregunta a Wompi por los pagos
  pendientes. Si el aviso se pierde y el comensal cierra el celular, el pago entra igual en
  menos de un minuto.

Si un pago llega tarde y lo que pagaba ya lo pagó otra persona, la plata no se pierde: queda como
**saldo a favor** de la mesa y el personal recibe una alerta para devolverla.

## La pantalla de la cocina

Una sola pantalla para el personal, protegida con un enlace secreto:

- **Pedidos:** lo que hay que preparar, con el tiempo de espera y un botón "Listo".
- **Mesas que necesitan a alguien:** alertas con su motivo y el botón que lo resuelve.
  - Plata que no se pudo aplicar → **Devolver** (se registra; la plata se devuelve a mano, por
    Nequi, transferencia o efectivo) → **Llegó** / **No llegó**.
  - Un pedido que no llegó a la cocina → **Reintentar envío**.
  - Un cobro trabado → **Reanudar cobro** o **Cancelar ronda**.
- **Cobros abiertos:** rondas esperando pago, quién tiene apartada su parte, y los botones
  **Liberar** (soltar una parte apartada) y **Cancelar ronda**.
- **Cobrar en caja:** en "Cobros abiertos" y en "Mesas abiertas", el mesero registra un pago
  recibido en **efectivo o datáfono**, de una persona o de todo lo que falta. No se escribe el
  monto: es lo que suma esa parte (más la propina, si hay). Pide confirmación y no se puede
  deshacer.
- **Mesas abiertas:** cuánto debe cada mesa y cada persona, y los botones **Pedir la cuenta**,
  **Asumir pérdida** (si toda la mesa se fue: cubre toda la cuenta pendiente, nunca una parte, con
  motivo obligatorio) y **Cerrar mesa** (si no se puede, dice por qué).
- Aviso rojo si los pedidos dejan de llegar a la cocina.

Cada acción del personal queda registrada. Las alertas se quitan solas cuando se resuelve su
causa.

## Lo que el sistema garantiza

Estas reglas se prueban con tests de concurrencia (muchas personas a la vez) y con una auditoría
que revisa los datos reales (`npm run audit`).

- **No se cobra de más.** Una porción solo puede estar apartada por una persona a la vez, nunca se
  paga dos veces, y ninguna ronda recibe más de lo que vale.
- **La cocina recibe cada ronda exactamente una vez.** Nunca cero veces (comida pagada que no se
  cocina) y nunca dos.
- **Ningún pago aprobado se pierde.** Aunque llegue tarde, repetido o sin aviso de Wompi, queda
  registrado. Y si no se puede aplicar, se avisa al personal, incluso si la mesa ya se cerró.
- **Una mesa no se cierra con algo pendiente:** cuenta sin pagar, ronda en cobro, saldo a favor
  sin devolver, devolución en curso o alerta sin resolver.
- **"Asumir pérdida" no es un descuento:** cubre toda la cuenta pendiente, solo después de pedir la
  cuenta, con motivo, y queda registrado.

## Qué se probó y cómo

| Qué | Resultado |
|---|---|
| Esquema y permisos de la base de datos (`npm run verify:schema`) | 45/45 |
| Tests de lógica y concurrencia (`npm test`) | 262/262 |
| Tests en el navegador, con iPhone y Safari simulados (`npm run test:e2e`) | 26/26 |
| Auditoría de reglas sobre los datos (`npm run audit`) | 13/13 |

Probado en vivo con el sandbox de Wompi:

- **26 de septiembre**, desde un celular real: pagos con y sin aviso de Wompi, la vuelta a la mesa
  en 8 segundos, y la recuperación de un pago perdido.
- **27 de septiembre**, cancelar una ronda mientras alguien pagaba: la plata quedó como saldo a
  favor, no fue a la cocina, y se devolvió desde la pantalla de la cocina.
- **27 de septiembre**, cuenta abierta con dos personas (automatizado sobre la demo real y Wompi
  real): dos rondas, pedir la cuenta, un solo pago cada uno por sus dos rondas, y la mesa se cerró
  sola. Luego una mesa que se fue sin pagar: el personal asumió la pérdida y la mesa se cerró.

## Las piezas

| Pieza | Qué hace | Dónde está |
|---|---|---|
| Base de datos | Todas las reglas de plata viven aquí, en funciones SQL: mesas, rondas, porciones, reservas, pagos, cuentas, pérdidas, devoluciones, envíos. | `supabase/migrations/` |
| App del comensal | La página del celular: entrar, pedir, compartir, pagar, pedir la cuenta. | `public/`, `src/api/` (`npm run web`, puerto 8788) |
| Puente de Wompi | Recibe el aviso de Wompi y revisa cada minuto los pagos pendientes. | `src/wompi/` (`npm run wompi`, puerto 8787) |
| Worker de envíos | Entrega los pedidos pagados a la cocina y a la impresora; reintenta si falla. | `src/worker/` (`npm run worker`) |
| Pantalla de cocina | Pedidos, alertas y acciones del personal. | `src/kds/`, `public/kds/` (`npm run kds`, puerto 8790) |

## Montar un bar nuevo

1. Llenar la carta en Excel o Google Sheets con 4 columnas: `categoria`, `nombre`, `precio`,
   `impuesto` (por ejemplo `8` para 8%). Exportarla como CSV. Hay un ejemplo en
   `docs/carta-ejemplo.csv`.
2. Cargar el bar:
   `npm run venue:load -- --name "La Terraza" --mode open_tab --tables 12 --bar 3 --menu carta.csv`
   (`--mode`: `pay_before_order`, `open_tab` o `hybrid`). Si la carta tiene errores, dice cuáles y
   en qué fila, y no carga nada.
3. Imprimir los QR: `npm run venue:qr -- --name "La Terraza"`. Deja un PDF en la carpeta `qr/`,
   con 6 tarjetas por hoja para recortar y pegar en las mesas.

**El restaurante también puede hacerlo solo** desde la pantalla de la cocina, botón **"Carta"**:
subir su hoja de cálculo (ve los errores con su fila, o una vista previa de lo que se agrega, se
actualiza y se oculta, y nada cambia hasta tocar **Aplicar**) y marcar platos **agotados**, que
desaparecen al instante del menú de los comensales. Subir la carta en pleno servicio no "desagota"
nada.

Volver a cargar la carta actualiza precios y oculta los platos que ya no están. **Los QR de las
mesas nunca cambian**, así que no hay que reimprimirlos. Mientras no haya dominio, los QR apuntan a
la dirección de la Mac y solo funcionan en la misma red wifi; con el dominio se regeneran con
`--base https://…`.

## Cómo correrlo

```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
export DATABASE_URL='postgres://santiagozapata@localhost:5432/smart_group_tab'
set -a; source .env; set +a      # llaves de Wompi y tokens

npm run db:migrate && npm run db:seed
npm run web      # app del comensal (8788)
npm run wompi    # puente de Wompi + revisión cada minuto (8787)
npm run worker   # envíos a la cocina
npm run kds      # pantalla de cocina (8790)
npm run test:all # todas las pruebas, con su propia base de datos
```

Direcciones de la demo:

- **Comensal:** `http://santiagos-MacBook-Air.local:8788/t/qr-test-mesa-12` (con el nombre de la
  Mac, no con la IP: Wompi bloquea el pago si la dirección de regreso es una IP).
- **Cocina:** `http://localhost:8790/kds#token=prueba-cocina`.

El restaurante de la demo está en modo **cuenta abierta**.

## Specs (OpenSpec)

Nueve capacidades documentadas en `openspec/specs/`:

| Spec | De qué trata |
|---|---|
| `session-lifecycle` | La mesa: apertura por QR, apodos, modos de cobro, saldo a favor, pedir la cuenta. |
| `round-lifecycle` | Estados de una ronda, congelar el carrito, cancelar y reanudar. |
| `tab-settlement` | La cuenta: qué se debe, pagarla en un solo pago, asumir pérdida, cerrar la mesa. |
| `payment-reconciliation` | Encontrar los pagos cuyo aviso de Wompi no llegó. |
| `refund-registry` | Registro de devoluciones que el personal hace a mano. |
| `dispatch-delivery` | Cómo llegan los pedidos a la cocina, reintentos y límites. |
| `kitchen-display` | La pantalla de cocina: recibir, mostrar una sola vez, marcar listo. |
| `staff-alerts` | Mesas que necesitan a alguien, y cuándo se quita la alerta. |
| `staff-actions` | Las acciones del personal y su registro. |

## Historial

| Fecha | Qué se agregó |
|---|---|
| 19 sep | Base de datos, reservas sin cobrar de más, registro de pagos, carrito, Wompi, app del comensal |
| 20 sep | Primeras specs, tests en el navegador, envío de pedidos a la cocina |
| 26 sep | Pantalla de cocina y alertas; dos arreglos de pagos con Wompi; conciliación de pagos sin aviso |
| 26 sep | Demo limpia: base de datos aparte para los tests, QR con el nombre de la Mac |
| 26–27 sep | Acciones del personal: devolver, cancelar, reanudar, liberar, reintentar |
| 27 sep | Cerrar la cuenta: pedir la cuenta, un pago por persona, asumir pérdida, cierre automático |
| 27 sep | Nuevo diseño de la app del comensal como **Ronda** (logo, carta, barra de pago) |
| 27 sep | Pagos en efectivo y datáfono registrados por el personal |
| 30 sep | Montar un bar desde una hoja de cálculo, y QR imprimibles por mesa |
| 1 oct | El restaurante sube su carta y marca platos agotados desde la cocina |

## Lo que falta

**Para un piloto en un bar real:**

- **Ponerlo en internet:** un dominio, un servidor y la base de datos en la nube. Hoy todo corre
  en una Mac, y el túnel de Cloudflare que recibe los avisos de Wompi cambia de dirección cada vez
  que se reinicia.

**Funciones:**

- **Reabrir una mesa** después de pedir la cuenta ("queremos otra ronda").
- **Quitar un plato después de cerrar la ronda:** hoy solo se puede antes (es una regla a propósito).

**Más adelante:**

- Cuentas individuales del personal (hoy comparten un enlace secreto).
- Varios restaurantes, cada uno con su cuenta de Wompi y su pantalla de cocina.
- Rediseño de la pantalla de cocina y una página web de presentación de Ronda.

Limitaciones conocidas:

- Un pago abandonado se revisa cada minuto durante 24 horas: hasta 1.440 consultas a Wompi.
- La plata sobrante de una mesa no se usa sola para pagar la cuenta; se devuelve.
