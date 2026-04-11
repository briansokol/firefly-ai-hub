import type { Config } from '../types.js';
import type { ToolDefinition } from './registry.js';

interface GeoResult {
  name: string;
  latitude: number;
  longitude: number;
  country: string;
  admin1?: string;
}

interface WeatherData {
  current: {
    temperature_2m: number;
    relative_humidity_2m: number;
    apparent_temperature: number;
    wind_speed_10m: number;
    weather_code: number;
  };
  current_units: {
    temperature_2m: string;
    wind_speed_10m: string;
  };
}

const WEATHER_CODES: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Foggy',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  71: 'Slight snow',
  73: 'Moderate snow',
  75: 'Heavy snow',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

export function createWeatherTool(config: Config): ToolDefinition {
  const defaultLocation = config.tools?.weather?.default_location;

  return {
    name: 'get_weather',
    spec: {
      type: 'function',
      function: {
        name: 'get_weather',
        description:
          'Get current weather conditions for a location. ' +
          'Use this when the user asks about the weather.',
        parameters: {
          type: 'object',
          properties: {
            location: {
              type: 'string',
              description:
                'City name or location (e.g., "New York", "London", "Tokyo"). ' +
                (defaultLocation
                  ? `Defaults to "${defaultLocation}" if not specified.`
                  : 'Required.'),
            },
          },
          required: defaultLocation ? [] : ['location'],
        },
      },
    },
    handler: async (args) => {
      const location = (args.location as string) || defaultLocation;
      if (!location) {
        return 'Please specify a location (e.g., "New York").';
      }

      try {
        // Geocode the location
        const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
        const geoResponse = await fetch(geoUrl, { signal: AbortSignal.timeout(10000) });
        const geoData = (await geoResponse.json()) as { results?: GeoResult[] };

        if (!geoData.results?.length) {
          return `Could not find location: "${location}". Try a different city name.`;
        }

        const geo = geoData.results[0];
        const locationName = [geo.name, geo.admin1, geo.country]
          .filter(Boolean)
          .join(', ');

        // Fetch current weather
        const weatherUrl =
          `https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}&longitude=${geo.longitude}` +
          '&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,weather_code' +
          '&temperature_unit=fahrenheit&wind_speed_unit=mph';
        const weatherResponse = await fetch(weatherUrl, { signal: AbortSignal.timeout(10000) });
        const weather = (await weatherResponse.json()) as WeatherData;

        const c = weather.current;
        const condition = WEATHER_CODES[c.weather_code] ?? 'Unknown';

        return [
          `Weather in ${locationName}:`,
          `Condition: ${condition}`,
          `Temperature: ${c.temperature_2m}°F (feels like ${c.apparent_temperature}°F)`,
          `Humidity: ${c.relative_humidity_2m}%`,
          `Wind: ${c.wind_speed_10m} mph`,
        ].join('\n');
      } catch (err) {
        return `Failed to fetch weather: ${err instanceof Error ? err.message : 'unknown error'}`;
      }
    },
  };
}
