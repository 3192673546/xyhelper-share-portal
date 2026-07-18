export class ShareClient {
  constructor(baseUrl, { cacheMs = 15_000, timeoutMs = 8_000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.cacheMs = cacheMs;
    this.timeoutMs = timeoutMs;
    this.cachedAt = 0;
    this.cachedCars = [];
  }

  async listCars({ force = false } = {}) {
    if (!force && this.cachedCars.length && Date.now() - this.cachedAt < this.cacheMs) {
      return this.cachedCars;
    }
    const response = await fetch(`${this.baseUrl}/carpage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ page: 1, size: 500, sort: 'desc', order: 'sort' }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) throw new Error(`XYHelper 选车接口返回 ${response.status}`);
    const payload = await response.json();
    const list = payload?.data?.list;
    if (!Array.isArray(list)) throw new Error('XYHelper 选车接口数据格式不正确');
    this.cachedCars = list
      .map((item) => ({
        carID: String(item.carID || '').trim(),
        status: toBoolean(item.status),
        isPlus: toBoolean(item.isPlus)
      }))
      .filter((item) => item.carID)
      .slice(0, 500);
    this.cachedAt = Date.now();
    return this.cachedCars;
  }

  async getCar(carId) {
    const cars = await this.listCars();
    return cars.find((car) => car.carID === carId) || null;
  }
}

function toBoolean(value) {
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

export function canUseCar(user, car) {
  if (!user || !car || user.disabled || new Date(user.expiresAt).getTime() <= Date.now()) return false;
  if (user.allowedCars.length && !user.allowedCars.includes(car.carID)) return false;
  if (car.isPlus && user.tier !== 'plus') return false;
  return true;
}
