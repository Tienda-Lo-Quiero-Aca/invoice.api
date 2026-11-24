# Operación

Cómo desplegar, cómo verificar que quedó bien, y qué hacer ante los problemas más frecuentes.

← [Volver al inicio](../README.md)

**Contenido**

1. [Dónde corre](#dónde-corre)
2. [Deploy](#deploy)
3. [Verificar que está sano](#verificar-que-está-sano)
4. [Problemas frecuentes](#problemas-frecuentes)

---

## Dónde corre

| | |
|---|---|
| Servidor | Droplet de DigitalOcean |
| Directorio | `/opt/invoice.api` |
| Proceso | PM2, con el nombre `invoice-api` |
| Punto de entrada | `dist/src/main.js` |
| Configuración | `/opt/invoice.api/.env` |
| Redis | En el mismo servidor |

Dos detalles que evitan confusiones:

- **PM2 ejecuta el código compilado** (`dist/`), no el fuente. Traer cambios con `git pull` no modifica nada de lo que está corriendo.
- El punto de entrada es `dist/src/main.js`, no `dist/main.js`: como también se compila la carpeta `scripts/`, TypeScript conserva la estructura de directorios.

El archivo `ecosystem.config.cjs` existe solo en el servidor (no está en el repositorio) y tiene que apuntar a `dist/src/main.js`.

---

## Deploy

Tres pasos, y **los tres son necesarios**: traer el código, compilar y reiniciar.

```bash
cd /opt/invoice.api && git pull && cp -r dist dist.backup && npm run build && ls -l dist/src/main.js
```

El `ls` del final tiene que mostrar el archivo con la fecha y hora de ahora. Recién entonces:

```bash
pm2 restart invoice-api --update-env && rm -rf dist.backup
```

**Por qué el respaldo.** `npm run build` borra `dist/` antes de compilar. Si la compilación falla a mitad de camino, el servicio se queda sin nada que ejecutar. Con el respaldo se vuelve atrás así:

```bash
rm -rf dist && mv dist.backup dist && pm2 restart invoice-api
```

**Si cambiaron dependencias** (`package.json`), agregar `npm ci` antes de compilar.

**`--update-env`** hace que PM2 relea el `.env`. Sin eso, sigue con las variables que tenía cargadas.

**Si el cambio es solo de documentación** (`README.md` o `docs/*.md`), alcanza con `git pull`: el sitio en `/docs` lee los textos del repositorio en cada visita, sin compilar ni reiniciar.

### Confirmar que quedó la versión nueva

El método más confiable es buscar en el compilado algo que solo exista en el cambio que se subió:

```bash
grep -rl "TEXTO_DEL_CAMBIO" dist/ | head -1
```

Y que PM2 haya reiniciado de verdad:

```bash
pm2 list
```

La columna `uptime` tiene que mostrar segundos o minutos, no días.

---

## Verificar que está sano

**El proceso está arriba**

```bash
pm2 list
```

**Arrancó sin errores**

```bash
pm2 logs invoice-api --lines 60 --nostream
```

Entre las líneas de arranque tiene que aparecer:

```
Xubio comprobantes backfill schedule registered
```

Si en cambio dice `Could not register the Xubio comprobantes backfill schedule`, Redis no respondió al arrancar. El servicio funciona igual, pero la sincronización automática no quedó programada: revisar Redis y reiniciar.

**La sincronización con Madre está corriendo**

```bash
pm2 logs invoice-api --lines 300 --nostream | grep "backfill job completed" | tail -3
```

Tiene que haber una corrida completada en las últimas 2 horas.

**Las colas**

En `https://invoice.loquieroaca.com/admin/queues` (Bull Board, con usuario y contraseña) se ve qué hay en espera, qué está corriendo y qué falló en cada cola.

**Los últimos problemas registrados**

```bash
curl -s "https://invoice.loquieroaca.com/internal/tlqv-invoice/issues?status=open&limit=10" \
  -H "x-internal-api-key: $INVOICE_INTERNAL_API_KEY"
```

---

## Problemas frecuentes

### Subí un cambio y se sigue comportando igual

Casi siempre faltó compilar o reiniciar. `git pull` solo, o `npm run build` sin `pm2 restart`, no cambian lo que está corriendo.

Una señal clara: el mensaje de un bloqueo sigue usando el texto viejo. Verificar con `pm2 list` que el `uptime` sea reciente, y repetir el [deploy](#deploy) completo.

### Las credenciales de Xubio dejaron de funcionar

**Síntoma:** todas las ventas se bloquean con `XUBIO_EXISTING_CLIENT_LOOKUP_FAILED` y el detalle dice `invalid_client` o `Client authentication failed`. La sincronización con Madre también falla.

**Causa:** las credenciales de la aplicación en Xubio se revocaron o regeneraron.

**Solución:**

1. En Xubio, generar credenciales nuevas para la aplicación (`Client_id` y `Secret_id`).
2. En el servidor, cargarlas sin que queden en el historial de la terminal:

```bash
read -r -p "Client_id: " XCID && read -r -s -p "Secret_id: " XSEC && echo && NUEVO=$(printf '%s:%s' "$XCID" "$XSEC" | base64 -w0)
```

3. **Probarlas antes de tocar el `.env`:**

```bash
curl -s -X POST https://xubio.com/API/1.1/TokenEndpoint -H "Authorization: Basic $NUEVO" -d "grant_type=client_credentials" | head -c 120; echo
```

Tiene que responder con un `access_token`.

4. Guardarlas y reiniciar:

```bash
cd /opt/invoice.api && cp .env .env.backup && grep -v '^XUBIO_BASIC_AUTHORIZATION=' .env > .env.tmp && printf 'XUBIO_BASIC_AUTHORIZATION=%s\n' "$NUEVO" >> .env.tmp && mv .env.tmp .env && chmod 600 .env && pm2 restart invoice-api --update-env
```

5. Cuando esté confirmado que funciona, borrar el respaldo, que conserva las credenciales viejas: `rm .env.backup`.

### Todas las ventas fallan al buscar los datos del pedido

**Síntoma:** el error menciona `getting order details` y `HTTP 500`, con un detalle de Dataverse del estilo `Could not find a property named ...`.

**Causa:** no es de este servicio. Ops API le está pidiendo a Dynamics una columna que ya no existe.

**Solución:** se corrige en el repositorio de Ops API, quitando esa columna de la consulta. Mientras tanto no se puede facturar nada, porque el flujo se corta en el primer paso.

### Una venta quedó con "Xubio no respondió"

Bloqueo `XUBIO_INVOICE_OUTCOME_UNKNOWN`. **No reintentar a ciegas.**

1. Buscar en Xubio si existe una factura con ese TLQV en la descripción.
2. Si existe, no hacer nada: Madre la va a tomar en la próxima sincronización.
3. Si no existe, reintentar.

Reintentar sin mirar puede dejar dos facturas con CAE para la misma venta.

### Una venta ya facturada no aparece como facturada

**Causa:** Madre todavía no tiene el comprobante. La sincronización corre cada 2 horas.

**Solución:** esperar, o forzarla para el día en cuestión:

```bash
curl -s -X POST "https://invoice.loquieroaca.com/internal/xubio/comprobantes/backfill" \
  -H "x-internal-api-key: $INVOICE_INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"fechaDesde":"2026-11-24","fechaHasta":"2026-11-24"}'
```

Si la sincronización automática no está corriendo, revisar los logs como se indica en [verificar que está sano](#verificar-que-está-sano).

### La planilla no responde

Bloqueo `SPREADSHEET_SOURCE_DATA_UNAVAILABLE`. La planilla lee una hoja de Google en vivo y a veces se cuelga. El servicio ya reintenta 3 veces cada lectura.

**Solución:** reintentar la venta. Si pasa seguido, subir `SPREADSHEET_API_TIMEOUT_MS` a `30000`.

### AFIP/ARCA está caído

Bloqueo `FISCAL_INFO_UNAVAILABLE`. El lote lo reintenta 3 veces en alrededor de un minuto; una caída de ARCA suele durar más.

**Solución:** volver a pasar las ventas bloqueadas más tarde. No hay nada que corregir.

### Un total no cierra

Bloqueo `INVOICE_TOTAL_SALE_PRICE_MISMATCH`. Para ver de dónde sale cada importe, correr la venta en modo prueba:

```bash
curl -s -X POST "https://invoice.loquieroaca.com/internal/tlqv-invoice/facturas/create-from-tlqv" \
  -H "x-internal-api-key: $INVOICE_INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tlqvCode":"TLQV-22209","stopAfter":"invoice_creation","dryRun":true}'
```

En la respuesta, `invoiceBuild.itemMappings` lista cada concepto con la solapa, la columna, el valor leído y el importe que iría a Xubio. Comparar contra la fila de la planilla suele mostrar enseguida cuál es el número que no corresponde.

### El servicio se reinicia solo

PM2 lo reinicia si supera 512 MB de memoria (`max_memory_restart`). La columna `↺` de `pm2 list` cuenta los reinicios. Algunos son esperables; si el número crece rápido, revisar los logs alrededor de cada reinicio:

```bash
pm2 logs invoice-api --lines 200 --nostream --err
```
