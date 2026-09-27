# Smart Group Tab — qué hay construido

Estado al 26 de septiembre de 2026 (`main` = `d3367c0`).

## Qué es

Una cuenta compartida para bares y gastrobares. Varias personas en la misma mesa escanean
un QR, piden desde su celular a un carrito común y pagan cada una su parte con Wompi
(tarjeta, Nequi, PSE). **La cocina solo recibe una ronda cuando está pagada completa.**

Como la plata en Wompi no se devuelve sola, el sistema está hecho para que sea imposible
cobrar de más, en vez de corregirlo después.

## Un pedido de punta a punta

1. **Entrar a la mesa.** El comensal escanea el QR (`/t/<mesa>`) y escribe un apodo.
2. **Pedir.** Todos agregan platos al mismo carrito. Un plato se puede dividir entre varias
   personas.
3. **Cerrar la ronda.** El carrito se congela. Lo que se pida después va a una ronda nueva.
4. **Reservar su parte.** Cada persona aparta las porciones que va a pagar durante 5 minutos.
   Nadie más puede pagarlas mientras tanto.
5. **Pagar en Wompi.** Se abre el checkout de Wompi con el monto exacto y una firma.
6. **Registrar el pago.** El pago llega por tres caminos, y el primero que llegue lo registra:
   - el aviso (webhook) de Wompi;
   - la revisión al volver a la mesa;
   - la revisión automática cada minuto.
7. **Enviar a la cocina.** Cuando toda la ronda está pagada, un proceso aparte (el worker)
   la entrega a la pantalla de la cocina y a la impresora.
8. **Cocina.** La cocina ve el pedido y lo marca "Listo" cuando sale.

Si un pago llega tarde y sus porciones ya las pagó otro, la plata no se pierde: queda como
saldo a favor de la mesa y la mesa aparece en las alertas del personal.

## Las piezas

| Pieza | Qué hace | Dónde está |
|---|---|---|
| Base de datos | Mesas, sesiones, rondas, carrito, porciones, reservas, pagos, envíos, devoluciones. Todas las reglas de plata viven aquí, en funciones SQL. | `supabase/migrations/` |
| App del comensal | Página para el celular: entrar, pedir, dividir, pagar. | `public/`, `src/api/server.mjs` (`npm run web`, puerto 8788) |
| Puente de Wompi | Arma el link de pago firmado, recibe el aviso de Wompi y revisa cada minuto los pagos pendientes. | `src/wompi/` (`npm run wompi`, puerto 8787) |
| Conciliación | Pregunta a Wompi por los pagos cuyo aviso no llegó, con la llave privada. | `src/wompi/api.mjs`, `src/wompi/reconcile.mjs` |
| Worker de envíos | Entrega las rondas pagadas a la cocina y a la impresora. Reintenta si falla. | `src/worker/` (`npm run worker`) |
| Pantalla de cocina | Pedidos por preparar y alertas para el personal. Protegida con un token. | `src/kds/`, `public/kds/` (`npm run kds`, puerto 8790) |

## Lo que el sistema garantiza

Estas reglas se prueban con tests de concurrencia (muchas personas a la vez) y con una
auditoría sobre los datos reales (`npm run audit`).

- **No se cobra de más (I1).** Una porción solo puede estar reservada por una persona a la vez,
  y lo pagado nunca supera el total de la ronda.
- **La cocina recibe cada ronda exactamente una vez (I2).** Nunca cero veces (comida pagada que
  no se cocina) y nunca dos.
- **Ningún pago aprobado se pierde (I3).** Aunque llegue tarde, repetido o para una reserva
  vencida, queda registrado. Y si el aviso de Wompi nunca llega, la conciliación lo encuentra.

## Qué se probó y cómo

| Qué | Resultado |
|---|---|
| Esquema y permisos de la base de datos (`npm run verify:schema`) | 43/43 |
| Tests de lógica y concurrencia (`npm test`) | 193/193 |
| Tests en el navegador, con iPhone y Safari simulados (`npm run test:e2e`) | 20/20 |
| Auditoría de reglas sobre los datos (`npm run audit`) | 10/10 |
| Pagos reales en el sandbox de Wompi, desde un celular | Funciona de punta a punta |

Probado en vivo con Wompi sandbox el 26 de septiembre:

- Un pago con aviso de Wompi llegó a la cocina.
- Dos pagos **sin** aviso de Wompi los encontró la revisión cada minuto y llegaron a la cocina.
- Un pago se registró 8 segundos después de aprobado, al volver a la mesa.
- Un pago perdido de la mañana ($144.720) se recuperó y quedó como saldo a favor de la Mesa 12.

## Cómo correrlo

```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
export DATABASE_URL='postgres://santiagozapata@localhost:5432/smart_group_tab'
set -a; source .env; set +a      # llaves de Wompi y tokens (nada lee .env solo)

npm run db:migrate && npm run db:seed
npm run web      # app del comensal (8788)
npm run wompi    # puente de Wompi + revisión cada minuto (8787)
npm run worker   # envíos a la cocina
npm run kds      # pantalla de cocina (8790)
```

Direcciones para la demo:

- Comensal: `http://santiagos-MacBook-Air.local:8788/t/qr-test-mesa-12`. Hay que usar el nombre
  y no la IP, porque Wompi bloquea el pago si la dirección de regreso es una IP.
- Cocina: `http://localhost:8790/kds#token=prueba-cocina`.

Antes de `npm test`, detener `npm run worker`: si queda corriendo, se roba envíos de los tests.

Variables de `.env` (ver `.env.example`): `WOMPI_PUBLIC_KEY`, `WOMPI_INTEGRITY_SECRET`,
`WOMPI_EVENTS_SECRET`, `WOMPI_PRIVATE_KEY`, `DISPATCH_TOKEN`, `KDS_STAFF_TOKEN`, entre otras.
`.env` no se sube a git.

## Specs (OpenSpec)

Siete capacidades documentadas en `openspec/specs/`:

| Spec | De qué trata |
|---|---|
| `session-lifecycle` | La cuenta de la mesa: apertura por QR, apodos, modos de cobro, saldo a favor. |
| `round-lifecycle` | Estados de una ronda, congelar el carrito, desborde a una ronda nueva. |
| `refund-registry` | Registro de devoluciones, que el personal hace a mano. |
| `dispatch-delivery` | Cómo el worker entrega a la cocina, reintentos y límites. |
| `kitchen-display` | La pantalla de cocina: recibir, mostrar una sola vez, marcar listo. |
| `staff-alerts` | Mesas que necesitan a alguien y aviso de worker detenido. |
| `payment-reconciliation` | Encontrar pagos cuyo aviso de Wompi no llegó. |

## Historial

| Fecha | Commit | Qué se agregó |
|---|---|---|
| 19 sep | `34fa53e` | Base de datos, reservas atómicas, registro de pagos, carrito, adaptador de Wompi, app del comensal |
| 20 sep | `24122cd` – `89df1b5` | Nombres de estados alineados, primeras specs, tests en el navegador |
| 20 sep | `aedc6df` | Worker de envíos a la cocina |
| 26 sep | `c323a63` | Pantalla de cocina y alertas del personal |
| 26 sep | `17fd25a` | Arreglo: la firma del pago incluye su vencimiento, como pide Wompi |
| 26 sep | `7913da6` | Arreglo: un pago rechazado por Wompi nunca se registra como pago simulado |
| 26 sep | `e7863ae` – `d3367c0` | Conciliación con Wompi |

## Lo que falta

- **Cerrar la cuenta de la mesa** (`close_session`). Falta decidir quién cubre lo que no se pagó
  en una mesa con cuenta abierta.
- **Acciones del personal:** forzar un envío, liberar reservas, cancelar una ronda, registrar
  una devolución. Hoy la cocina solo muestra alertas.
- **Cuentas del personal y un restaurante por pantalla.** Hoy hay un solo token y la cocina
  muestra todos los restaurantes juntos.
- **Llaves de Wompi por restaurante.** Hoy toda la plata va a una sola cuenta de Wompi.

Limitaciones conocidas:

- Los tests y la demo usan la misma base de datos, por eso la cocina muestra cientos de pedidos
  de prueba.
- El QR que imprime `npm run web` usa la IP, así que con él el comensal no vuelve a la mesa
  después de pagar. El pago igual se registra con la revisión cada minuto.
- Un pago abandonado se revisa cada minuto durante 24 horas: hasta 1.440 consultas a Wompi.
- El túnel de Cloudflare cambia de dirección cada vez que se reinicia, y hay que volver a
  pegarla en el panel de Wompi ("URL de Eventos").

## ¿Con qué seguir? (opciones abiertas)

La meta del MVP ya funciona de punta a punta: dos celulares en la misma mesa, carrito
compartido, pago dividido en Wompi sandbox y pedido en la pantalla de cocina. Estas son las
opciones para el siguiente paso, de la más pequeña a la más grande:

1. **Dejar la demo limpia** (pequeño, uno o dos días).
   - Base de datos aparte para los tests, para que la cocina no muestre pedidos de prueba.
   - Que el QR use el nombre del computador y no la IP, para que el comensal siempre vuelva a
     la mesa después de pagar.
2. **Acciones del personal en la pantalla de cocina** (mediano). Hoy las alertas solo se ven;
   una mesa marcada queda marcada para siempre. Faltan botones para:
   - registrar la devolución de un saldo a favor;
   - cancelar una ronda;
   - liberar una reserva trabada;
   - reintentar un envío a la cocina que falló.
3. **Cerrar la cuenta de la mesa** (mediano). Bloqueado por una decisión de negocio: en una
   mesa con cuenta abierta, si alguien se va sin pagar su parte, ¿quién la cubre: el resto de
   la mesa, el restaurante o el mesero?
4. **Varios restaurantes** (grande). Cada restaurante con sus propias llaves de Wompi (hoy
   toda la plata va a una sola cuenta), sus cuentas de personal y su propia pantalla de cocina.

Recomendación técnica: 1, después 2. El 3 necesita primero la respuesta de negocio. El 4
solo cuando haya un segundo restaurante real.

**Preguntas para quien revise:**

- ¿Qué es más importante ahora: una demo impecable o poder operar una noche real en un bar?
- ¿Quién cubre la parte que alguien no pagó en una cuenta abierta?
- ¿Hay un segundo restaurante a la vista?
