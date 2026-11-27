import { normalizeXubioProvinciaNombre } from './normalizeXubioProvinciaNombre';

describe('normalizeXubioProvinciaNombre', () => {
  it.each([
    // What Mercado Libre sent for TLQV-23750, and Xubio rejected.
    ['CIUDAD_AUTONOMA_BUENOS_AIRES', 'Ciudad Autónoma de Buenos Aires'],
    ['CIUDAD AUTONOMA DE BUENOS AIRES', 'Ciudad Autónoma de Buenos Aires'],
    ['Ciudad Autónoma de Buenos Aires', 'Ciudad Autónoma de Buenos Aires'],
    ['Capital Federal', 'Ciudad Autónoma de Buenos Aires'],
    ['CABA', 'Ciudad Autónoma de Buenos Aires'],
    ['C.A.B.A.', 'Ciudad Autónoma de Buenos Aires'],
    ['Ciudad de Buenos Aires', 'Ciudad Autónoma de Buenos Aires'],
    ['BUENOS_AIRES', 'Buenos Aires'],
    ['Provincia de Buenos Aires', 'Buenos Aires'],
    ['  buenos aires ', 'Buenos Aires'],
    ['Córdoba', 'Cordoba'],
    ['ENTRE_RIOS', 'Entre Rios'],
    ['Entre Ríos', 'Entre Rios'],
    ['SANTIAGO_DEL_ESTERO', 'Santiago del Estero'],
    ['Santiago Estero', 'Santiago del Estero'],
    ['TIERRA_DEL_FUEGO', 'Tierra del Fuego'],
    [
      'Tierra del Fuego, Antártida e Islas del Atlántico Sur',
      'Tierra del Fuego',
    ],
    ['Neuquén', 'Neuquen'],
    ['LA_PAMPA', 'La Pampa'],
    ['Tucumán', 'Tucuman'],
  ])('writes %s as %s', (value, expected) => {
    expect(normalizeXubioProvinciaNombre(value)).toBe(expected);
  });

  it('does not confuse Buenos Aires with the city', () => {
    expect(normalizeXubioProvinciaNombre('Buenos Aires')).toBe('Buenos Aires');
  });

  it('leaves alone what is not a province, for Xubio to reject by name', () => {
    expect(normalizeXubioProvinciaNombre('Montevideo')).toBe('Montevideo');
  });
});
