/**
 * Where this station publishes, beyond this site.
 *
 * Each entry is a public page on a weather network the Pi uploads to (see the
 * uploaders in `pi/src/weatherstation/upload/`). Ids are the same ones in the
 * Pi's `uploaders.*.station_id` config — kept here by hand because the web app
 * never reads the collector's config.
 */
export interface StationLink {
  /** Network name, as shown on the link. */
  network: string;
  /** Our station/site id on that network. */
  id: string;
  /** Public page for this station. */
  url: string;
  /** One-line note about what the network is. */
  note: string;
}

export const STATION_LINKS: StationLink[] = [
  {
    network: "Weather Underground",
    id: "IHOLMP2",
    url: "https://www.wunderground.com/dashboard/pws/IHOLMP2",
    note: "Live tile, history tables and monthly summaries",
  },
  {
    network: "Windy",
    id: "C9fexco",
    url: "https://www.windy.com/station/pws-C9fexco",
    note: "Our readings on Windy's forecast map",
  },
  {
    network: "CWOP / NOAA MADIS",
    id: "GW7965",
    url: "https://aprs.fi/weather/a/GW7965",
    note: "Feeds NOAA's forecast models via APRS",
  },
  {
    network: "WOW Belgium",
    id: "01a05493-9d3d-72b5-974a-d071b2319861",
    url:
      "https://wow.meteo.be/?id=01a05493-9d3d-72b5-974a-d071b2319861&lang=en" +
      "&zoomLevel=13&lat=53.584606&long=-6.139778",
    note: "RMI Belgium's international observations map",
  },
];
