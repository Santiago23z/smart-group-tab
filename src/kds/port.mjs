// KDS_PORT locally (it shares the machine with the other three services);
// PORT on a platform like Railway, which gives each service its own.
export const kdsPort = (env) => Number(env.KDS_PORT ?? env.PORT ?? 8790)
