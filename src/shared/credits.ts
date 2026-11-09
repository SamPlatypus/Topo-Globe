/**
 * Data credits.  These strings are shown as plain text in the app menu and are
 * embedded in every region file and on the download page.
 */
export interface Credit { id: string; title: string; text: string }

export const CREDITS: Credit[] = [
  {
    id: 'osm',
    title: 'Roads, tracks and paths',
    text:
      'Roads, tracks, paths and walker points of interest © OpenStreetMap contributors. ' +
      'Available under the Open Database Licence (ODbL) 1.0 – openstreetmap.org/copyright. ' +
      'The region files are a derived database and are likewise available under the ODbL.',
  },
  {
    id: 'copernicus',
    title: 'Elevation',
    text:
      'Elevation: produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH ' +
      '2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved. The organisations in ' +
      'charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the ' +
      'Copernicus WorldDEM-30. (Copernicus DEM GLO-30; heights relative to the EGM2008 geoid.)',
  },
  {
    id: 'vicmap',
    title: 'Waterways',
    text:
      'Waterways and water bodies: Vicmap Hydro © State of Victoria (Department of Transport and Planning), ' +
      'licensed under Creative Commons Attribution 4.0 International (CC BY 4.0). Changes: clipped to ' +
      '1° regions, simplified (≤ 4 m) and re-encoded.',
  },
  {
    id: 'wmm',
    title: 'Magnetic model',
    text: 'Magnetic declination: World Magnetic Model WMM2025, NOAA National Centers for Environmental Information and the British Geological Survey (public domain).',
  },
  {
    id: 'ne',
    title: 'Globe',
    text: 'Globe base map: Natural Earth (public domain).',
  },
];
