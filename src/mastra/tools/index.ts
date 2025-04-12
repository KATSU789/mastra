import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createLogger } from '@mastra/core/logger';
import * as dns from 'dns';
import { networkInterfaces } from 'os';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);
const logger = createLogger({
  name: 'weatherTool',
  level: 'debug',
});

interface GeocodingResponse {
  results: {
    latitude: number;
    longitude: number;
    name: string;
  }[];
}
interface WeatherResponse {
  current: {
    time: string;
    temperature_2m: number;
    apparent_temperature: number;
    relative_humidity_2m: number;
    wind_speed_10m: number;
    wind_gusts_10m: number;
    weather_code: number;
  };
}

// ネットワーク診断関数
async function diagnoseNetwork(host: string): Promise<void> {
  logger.debug(`--------- ネットワーク診断: ${host} ---------`);
  
  // DNS解決をテスト
  try {
    logger.debug(`DNS解決をテスト中: ${host}`);
    const addresses = await new Promise<string[]>((resolve, reject) => {
      dns.resolve(host, (err, addresses) => {
        if (err) reject(err);
        else resolve(addresses);
      });
    });
    logger.debug(`DNS解決成功: ${host} => ${addresses.join(', ')}`);
  } catch (error) {
    logger.error(`DNS解決失敗: ${host} - ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
  
  // ネットワークインターフェイス情報
  try {
    const interfaces = networkInterfaces();
    logger.debug('WSLネットワークインターフェイス:');
    Object.keys(interfaces).forEach((name) => {
      const networkInterface = interfaces[name];
      if (networkInterface) {
        networkInterface.forEach((net) => {
          logger.debug(`  ${name}: ${net.address} (${net.family})`);
        });
      }
    });
  } catch (error) {
    logger.error(`ネットワークインターフェイス情報取得失敗: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
  
  // resolv.conf内容（ESモジュール対応）
  try {
    logger.debug('DNS設定 (/etc/resolv.conf):');
    const { execSync } = await import('child_process');
    const resolvConf = execSync('cat /etc/resolv.conf').toString();
    logger.debug(resolvConf);
  } catch (error) {
    logger.error(`resolv.conf読み取り失敗: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
  
  logger.debug('--------- 診断終了 ---------');
}

// curlを使用してAPIリクエストを実行
async function fetchWithCurl(url: string, timeoutSeconds = 60): Promise<any> {
  logger.debug(`curl呼び出し開始: ${url}`);
  try {
    const { stdout } = await execAsync(`curl -s --max-time ${timeoutSeconds} "${url}"`);
    const data = JSON.parse(stdout);
    logger.debug(`curl呼び出し成功: データサイズ=${stdout.length}バイト`);
    return data;
  } catch (error) {
    logger.error(`curl呼び出し失敗: ${error instanceof Error ? error.message : 'Unknown error'}`);
    if (error instanceof Error && error.message.includes('Command failed')) {
      logger.error(`curlコマンドエラー: ${error.message}`);
    }
    throw error;
  }
}

export const weatherTool = createTool({
  id: 'get-weather',
  description: 'Get current weather for a location',
  inputSchema: z.object({
    location: z.string().describe('City name'),
  }),
  outputSchema: z.object({
    temperature: z.number(),
    feelsLike: z.number(),
    humidity: z.number(),
    windSpeed: z.number(),
    windGust: z.number(),
    conditions: z.string(),
    location: z.string(),
  }),
  execute: async ({ context }) => {
    try {
      logger.debug(`Fetching weather for location: ${context.location}`);
      return await getWeather(context.location);
    } catch (error) {
      logger.error(`Error fetching weather: ${error instanceof Error ? error.message : 'Unknown error'}`);
      if (error instanceof Error && error.stack) {
        logger.error(`Error stack: ${error.stack}`);
      }
      throw error;
    }
  },
});

const getWeather = async (location: string) => {
  try {
    // ネットワーク診断を実行
    await diagnoseNetwork('geocoding-api.open-meteo.com');
    await diagnoseNetwork('api.open-meteo.com');
    
    const geocodingUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`;
    logger.debug(`Geocoding URL: ${geocodingUrl}`);
    
    // curlを使用してGeocodingデータを取得
    const geocodingData = await fetchWithCurl(geocodingUrl, 60) as GeocodingResponse;
    logger.debug(`Geocoding response parsed successfully: ${JSON.stringify(geocodingData).substring(0, 200)}...`);

    if (!geocodingData.results?.[0]) {
      throw new Error(`Location '${location}' not found`);
    }

    const { latitude, longitude, name } = geocodingData.results[0];
    logger.debug(`Found location: ${name} at ${latitude},${longitude}`);

    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,weather_code`;
    logger.debug(`Weather URL: ${weatherUrl}`);
    
    // curlを使用して天気データを取得
    const data = await fetchWithCurl(weatherUrl, 60) as WeatherResponse;
    logger.debug(`Weather response parsed successfully: ${JSON.stringify(data).substring(0, 200)}...`);

    return {
      temperature: data.current.temperature_2m,
      feelsLike: data.current.apparent_temperature,
      humidity: data.current.relative_humidity_2m,
      windSpeed: data.current.wind_speed_10m,
      windGust: data.current.wind_gusts_10m,
      conditions: getWeatherCondition(data.current.weather_code),
      location: name,
    };
  } catch (error) {
    logger.error(`Error in getWeather: ${error instanceof Error ? error.message : 'Unknown error'}`);
    if (error instanceof Error && error.stack) {
      logger.error(`Error stack: ${error.stack}`);
    }
    throw error;
  }
};

function getWeatherCondition(code: number): string {
  const conditions: Record<number, string> = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Foggy',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    56: 'Light freezing drizzle',
    57: 'Dense freezing drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    66: 'Light freezing rain',
    67: 'Heavy freezing rain',
    71: 'Slight snow fall',
    73: 'Moderate snow fall',
    75: 'Heavy snow fall',
    77: 'Snow grains',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    85: 'Slight snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with slight hail',
    99: 'Thunderstorm with heavy hail',
  };
  return conditions[code] || 'Unknown';
}
