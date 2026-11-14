// Survey modes (presets). A mode decides what the plan is made of, how the app
// guides you, what the quick-action button does and which note categories and
// data fields are offered. The GPS track, notes, photos and exports work the same in all.
export const MODES = {
  ism: {
    name: 'Gas walkover (ISM)', blurb: 'Walk transects with a gas monitor; merge its log onto the track afterwards.',
    guide: 'route', action: 'mark', unit: 'ppm',
    categories: 'Exceedance, Crack / fissure, Vegetation stress, Odour, Leachate, Erosion, Well / borehole, Cover damage, Other',
  },
  soil: {
    name: 'Contaminated land sampling', blurb: 'Plan sampling locations (grid, random, targeted), navigate to each and log samples.',
    guide: 'points', action: 'sample', unit: 'ppm',
    categories: 'Staining, Odour, Fill / waste, Suspected asbestos, Stockpile, Tank / pipework, Drain / sump, Stressed vegetation, Access issue, Other',
  },
  general: {
    name: 'General field recording', blurb: 'Track, notes and photos, with an optional route or set of points to visit.',
    guide: 'auto', action: 'mark', unit: '',
    categories: 'Observation, Photo point, Feature, Hazard, Access, Other',
  },
};

export const PATTERNS = {
  square: 'Square grid',
  triangular: 'Triangular grid',
  herringbone: 'Herringbone grid',
  random: 'Random',
};

/** Smallest circular hotspot (diameter, m) a square grid of spacing G finds with 95% confidence: G = R / 0.59. */
export const hotspotDiameter = (spacing) => 2 * 0.59 * spacing;

// Fields on the sample form. type: text | number | chips (pick one) | multi (pick any) | area.
// `sticky` fields carry over to the next sample.
export const SAMPLE_FIELDS = [
  { key: 'type', label: 'Sample type', type: 'chips', sticky: false, def: 'Primary', options: ['Primary', 'Duplicate', 'Triplicate', 'Composite sub-sample', 'Rinsate blank', 'Trip blank', 'No sample (log only)'] },
  { key: 'method', label: 'Method', type: 'chips', sticky: true, options: ['Hand auger', 'Trowel / spade', 'Test pit', 'Borehole', 'Push tube', 'Surface scrape', 'Stockpile grab'] },
  { key: 'stratum', label: 'Material', type: 'chips', sticky: false, options: ['Topsoil', 'Fill', 'Natural', 'Stockpile', 'Sediment'] },
  { key: 'soil', label: 'Soil type', type: 'multi', sticky: false, options: ['Clay', 'Silt', 'Sand', 'Gravel', 'Cobbles', 'Peat / organic'] },
  { key: 'colour', label: 'Colour', type: 'text', sticky: false },
  { key: 'moisture', label: 'Moisture', type: 'chips', sticky: false, options: ['Dry', 'Moist', 'Wet', 'Saturated'] },
  { key: 'odour', label: 'Odour', type: 'chips', sticky: false, options: ['None', 'Slight', 'Moderate', 'Strong'] },
  { key: 'evidence', label: 'Evidence of contamination', type: 'multi', sticky: false, options: ['None seen', 'Staining', 'Sheen', 'Ash / clinker', 'Demolition rubble', 'Suspected ACM', 'Refuse', 'Oil / tar', 'Unnatural colour'] },
  { key: 'pid', label: 'PID / field screen reading (ppm)', type: 'number', sticky: false },
  { key: 'analytes', label: 'Analysis requested', type: 'multi', sticky: true, options: 'analytes' },
  { key: 'containers', label: 'Containers', type: 'text', sticky: true, placeholder: 'e.g. 1 × glass jar, 1 × asbestos bag' },
  { key: 'sampler', label: 'Sampled by', type: 'text', sticky: true },
  { key: 'weather', label: 'Weather', type: 'text', sticky: true, placeholder: 'e.g. fine, dry for 3 days' },
];
export const DEFAULT_ANALYTES = 'Heavy metals, TPH, BTEX, PAH, OCP, Asbestos, PFAS, VOC, SVOC, pH, Hold';
