/**
 * The provinces as Xubio's catalog (`provinciaBean`) names them. A cliente
 * whose province is not one of these is rejected outright: "La entidad
 * NXVProvincia cuyo nombre es: … no existe".
 */
const XUBIO_PROVINCIAS = [
  'Buenos Aires',
  'Catamarca',
  'Chaco',
  'Chubut',
  'Ciudad Autónoma de Buenos Aires',
  'Cordoba',
  'Corrientes',
  'Entre Rios',
  'Formosa',
  'Jujuy',
  'La Pampa',
  'La Rioja',
  'Mendoza',
  'Misiones',
  'Neuquen',
  'Rio Negro',
  'Salta',
  'San Juan',
  'San Luis',
  'Santa Cruz',
  'Santa Fe',
  'Santiago del Estero',
  'Tierra del Fuego',
  'Tucuman',
] as const;

const CABA = 'Ciudad Autónoma de Buenos Aires';

// Other ways the same province gets written by the sources the buyer's
// address comes from: Ops API, Mercado Libre and AFIP.
const ALIASES: Record<string, string> = {
  CAPITALFEDERAL: CABA,
  CABA,
  CIUDADBUENOSAIRES: CABA,
  PROVINCIABUENOSAIRES: 'Buenos Aires',
  BSAS: 'Buenos Aires',
  // AFIP's full name: "Tierra del Fuego, Antártida e Islas del Atlántico Sur".
  TIERRAFUEGOANTARTIDAEISLASATLANTICOSUR: 'Tierra del Fuego',
};

const BY_KEY = new Map<string, string>([
  ...XUBIO_PROVINCIAS.map((nombre): [string, string] => [
    buildKey(nombre),
    nombre,
  ]),
  ...Object.entries(ALIASES),
]);

/**
 * The province the way Xubio knows it, whatever the source wrote: upper or
 * lower case, with or without accents, with underscores instead of spaces
 * ("CIUDAD_AUTONOMA_BUENOS_AIRES", as Mercado Libre sends it), with or
 * without the "de" / "del" in the middle.
 *
 * A value that matches no province is returned as it came: Xubio will reject
 * it with its own message, which names the value and is what gets reported.
 */
export function normalizeXubioProvinciaNombre(value: string): string {
  return BY_KEY.get(buildKey(value)) ?? value;
}

function buildKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((word) => word !== '' && word !== 'DE' && word !== 'DEL')
    .join('');
}
