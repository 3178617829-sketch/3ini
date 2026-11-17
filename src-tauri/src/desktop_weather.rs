//! 面板天气条的数据来源：Windows 系统定位 → 逆地理拿城市名 → Open-Meteo 取天气。
//!
//! 为什么要放在 Rust 侧（2026-11-15 用户拍板「天气在 Rust 侧做」）：
//! 1. 定位走 WinRT `Windows.Devices.Geolocation.Geolocator`，前端 WebView 拿不到；
//! 2. 定位与逆地理都很慢（实测首次定位数秒），必须缓存，否则每次开面板都要等；
//! 3. 代理污染问题只在 Rust 侧能可靠规避（见下方 `no_proxy`）。
//!
//! ⚠️ 定位精度与来源：`Geolocator` 默认走 WiFi/网络定位（实测 74 米）。
//! ⚠️ **IP 定位会被系统代理污染**——本机开着 Clash（127.0.0.1:7897）时，
//!    任何基于 IP 的兜底会报香港。所以这里的请求一律显式绕过代理。

use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::services::notes::AppError;

/// 定位 + 城市名的缓存有效期。天气本身 10 分钟刷一次，定位 30 分钟内复用。
const LOCATION_TTL: Duration = Duration::from_secs(30 * 60);
/// 天气数据的缓存有效期。
const WEATHER_TTL: Duration = Duration::from_secs(10 * 60);
/// 定位最长等待时间，超时就走「无定位」降级（不报错，只让面板显示「定位失败」）。
const LOCATION_TIMEOUT: Duration = Duration::from_secs(12);

/// 面板天气条需要的一屏数据。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelWeather {
    /// 摄氏度，保留一位小数。
    pub temperature: f64,
    /// WMO 天气码（0~99），前端查表换成中文现象与图标。
    pub weather_code: u32,
    /// WMO 天气码对应的中文现象，例如「多云」。Rust 侧直接给，前端不必再维护一张表。
    pub weather_text: String,
    /// 今天最高温。
    pub temp_max: Option<f64>,
    /// 今天最低温。
    pub temp_min: Option<f64>,
    /// 城市名（市/区），定位失败时为空串。
    pub city: String,
    /// 数据来源说明：`system` = Windows 系统定位，`none` = 定位不可用。
    pub source: String,
    /// 定位精度（米），未知为 None。
    pub accuracy: Option<f64>,
}

/// 缓存：定位结果与天气分开存，天气过期时定位还能复用。
struct Cache {
    location: Option<(Instant, Location)>,
    weather: Option<(Instant, PanelWeather)>,
}

#[derive(Debug, Clone)]
struct Location {
    latitude: f64,
    longitude: f64,
    accuracy: Option<f64>,
    source: String,
}

static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();

fn cache() -> &'static Mutex<Cache> {
    CACHE.get_or_init(|| {
        Mutex::new(Cache {
            location: None,
            weather: None,
        })
    })
}

/// 给面板用：拿天气。命中缓存直接返回，否则现取一次。
///
/// `force_refresh` 为 true 时忽略缓存（前端「点一下天气条刷新」用）。
pub fn panel_weather(force_refresh: bool) -> Result<PanelWeather, AppError> {
    {
        let guard = cache().lock().map_err(|_| poison_error())?;
        if !force_refresh {
            if let Some((at, weather)) = &guard.weather {
                if at.elapsed() < WEATHER_TTL {
                    return Ok(weather.clone());
                }
            }
        }
    }

    let location = current_location(force_refresh)?;
    let weather = fetch_weather(&location)?;

    {
        let mut guard = cache().lock().map_err(|_| poison_error())?;
        guard.weather = Some((Instant::now(), weather.clone()));
    }
    Ok(weather)
}

/// 后台预热：启动后静默跑一次，把定位缓存和天气缓存填上，
/// 这样用户第一次看面板时不用等定位。
pub fn warm_up_in_background() {
    std::thread::spawn(|| {
        // 让窗口先出来，别和首屏渲染抢 CPU（这台机器 8 核无独显，抢起来很明显）。
        std::thread::sleep(Duration::from_secs(3));
        if let Err(error) = panel_weather(false) {
            // 预热失败不算错误：用户开面板时会再试一次。
            eprintln!("weather warm-up failed: {error}");
        }
    });
}

fn poison_error() -> AppError {
    AppError {
        code: "weatherCache".into(),
        message: "weather cache lock was poisoned".into(),
        details: Default::default(),
    }
}

fn current_location(force_refresh: bool) -> Result<Location, AppError> {
    if !force_refresh {
        let guard = cache().lock().map_err(|_| poison_error())?;
        if let Some((at, location)) = &guard.location {
            if at.elapsed() < LOCATION_TTL {
                return Ok(location.clone());
            }
        }
    }

    let location = system_location().unwrap_or_else(|error| {
        eprintln!("system geolocation unavailable, continue without city: {error}");
        Location {
            latitude: f64::NAN,
            longitude: f64::NAN,
            accuracy: None,
            source: "none".into(),
        }
    });

    {
        let mut guard = cache().lock().map_err(|_| poison_error())?;
        guard.location = Some((Instant::now(), location.clone()));
    }
    Ok(location)
}

/// 用 Windows 系统定位拿经纬度。
///
/// 注意 API 选择：`Geocoordinate::Latitude()` / `Longitude()` 标了
/// `#[cfg(feature = "deprecated")]`，不打开那个 feature 就编译不过，
/// 打开后又会在运行时直接失败。正确走法是 `Coordinate()?.Point()?.Position()`。
#[cfg(target_os = "windows")]
fn system_location() -> Result<Location, AppError> {
    use windows::Devices::Geolocation::{Geolocator, PositionAccuracy, PositionSource};

    let geolocator = Geolocator::new().map_err(|error| winrt_error("create", error))?;
    geolocator
        .SetDesiredAccuracy(PositionAccuracy::High)
        .map_err(|error| winrt_error("setAccuracy", error))?;

    // WinRT 的 IAsyncOperation 在 tokio 之外不能直接 await，这里用阻塞等待。
    let operation = geolocator
        .GetGeopositionAsync()
        .map_err(|error| winrt_error("getPosition", error))?;
    let position = wait_operation(operation)?;

    let coordinate = position
        .Coordinate()
        .map_err(|error| winrt_error("coordinate", error))?;
    let point = coordinate
        .Point()
        .map_err(|error| winrt_error("point", error))?;
    let basic = point
        .Position()
        .map_err(|error| winrt_error("position", error))?;

    let accuracy = coordinate.Accuracy().ok();
    let source = match coordinate.PositionSource() {
        Ok(PositionSource::WiFi) => "wifi",
        Ok(PositionSource::Cellular) => "cellular",
        Ok(PositionSource::Satellite) => "satellite",
        Ok(PositionSource::IPAddress) => "ip",
        Ok(PositionSource::Unknown) | Err(_) => "unknown",
        Ok(_) => "unknown",
    };

    Ok(Location {
        latitude: basic.Latitude,
        longitude: basic.Longitude,
        accuracy,
        source: source.into(),
    })
}

#[cfg(target_os = "windows")]
fn winrt_error(stage: &str, error: windows::core::Error) -> AppError {
    AppError {
        code: format!("geolocation:{stage}"),
        message: error.message(),
        details: Default::default(),
    }
}

/// 阻塞等待一个 `IAsyncOperation`，最多等 `LOCATION_TIMEOUT`。
///
/// 用 `windows_future` 的 `IntoFuture` + 忙等轮询。定位通常 1~3 秒返回，
/// 超时后放一个空定位，绝不把面板卡住。
#[cfg(target_os = "windows")]
fn wait_operation<T>(
    operation: windows_future::IAsyncOperation<T>,
) -> Result<T, AppError>
where
    T: windows::core::RuntimeType + Clone + 'static,
{
    use std::future::{Future, IntoFuture};

    let future = operation.into_future();
    let deadline = Instant::now() + LOCATION_TIMEOUT;
    let waker = futures_waker_from_std();
    let mut context = std::task::Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);

    loop {
        match future.as_mut().poll(&mut context) {
            std::task::Poll::Ready(result) => {
                return result.map_err(|error| AppError {
                    code: "geolocation:async".into(),
                    message: error.message(),
                    details: Default::default(),
                })
            }
            std::task::Poll::Pending => {
                if Instant::now() >= deadline {
                    return Err(AppError {
                        code: "geolocation:timeout".into(),
                        message: "system geolocation timed out".into(),
                        details: Default::default(),
                    });
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

/// 一个最小 waker：定位的回调用的是线程池完成回调，轮询不需要被唤醒，
/// 所以 wake 什么都不用做。
#[cfg(target_os = "windows")]
fn futures_waker_from_std() -> std::task::Waker {
    use std::task::{RawWaker, RawWakerVTable, Waker};

    unsafe fn clone(_: *const ()) -> RawWaker {
        RawWaker::new(std::ptr::null(), &VTABLE)
    }
    unsafe fn wake(_: *const ()) {}
    unsafe fn wake_by_ref(_: *const ()) {}
    unsafe fn drop(_: *const ()) {}

    static VTABLE: RawWakerVTable = RawWakerVTable::new(clone, wake, wake_by_ref, drop);
    unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VTABLE)) }
}

#[cfg(not(target_os = "windows"))]
fn system_location() -> Result<Location, AppError> {
    Err(AppError {
        code: "geolocation:unsupported".into(),
        message: "system geolocation is only implemented on Windows".into(),
        details: Default::default(),
    })
}

#[derive(Deserialize)]
struct OpenMeteoResponse {
    current: OpenMeteoCurrent,
    daily: OpenMeteoDaily,
}

#[derive(Deserialize)]
struct OpenMeteoCurrent {
    temperature_2m: f64,
    weather_code: u32,
}

#[derive(Deserialize)]
struct OpenMeteoDaily {
    temperature_2m_max: Vec<f64>,
    temperature_2m_min: Vec<f64>,
}

#[derive(Deserialize)]
struct ReverseGeocodeResponse {
    #[serde(default)]
    city: String,
    #[serde(default)]
    locality: String,
    #[serde(default)]
    locality_info: Option<LocalityInfo>,
}

#[derive(Deserialize, Default)]
struct LocalityInfo {
    #[serde(default)]
    administrative: Vec<AdministrativeEntry>,
}

#[derive(Deserialize, Default)]
struct AdministrativeEntry {
    #[serde(default)]
    name: String,
    #[serde(default)]
    order: i64,
}

fn http_client() -> Result<reqwest::blocking::Client, AppError> {
    // ⚠️ 必须显式 no_proxy：本机开着 Clash，走系统代理时逆地理会拿到香港。
    reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(15))
        .user_agent("hua-jian-assistant/0.1")
        .build()
        .map_err(|error| AppError {
            code: "weather:client".into(),
            message: error.to_string(),
            details: Default::default(),
        })
}

fn fetch_weather(location: &Location) -> Result<PanelWeather, AppError> {
    // 没有定位时用一个中性坐标兜底会让用户看到错误城市的天气，
    // 所以这里宁可返回「定位不可用」，让面板如实显示。
    if !location.latitude.is_finite() || !location.longitude.is_finite() {
        return Err(AppError {
            code: "weather:noLocation".into(),
            message: "location unavailable".into(),
            details: Default::default(),
        });
    }

    let client = http_client()?;
    let url = format!(
        "https://api.open-meteo.com/v1/forecast?latitude={:.4}&longitude={:.4}\
         &current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min\
         &timezone=Asia%2FShanghai&forecast_days=1",
        location.latitude, location.longitude
    );

    let response: OpenMeteoResponse = client
        .get(&url)
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|error| AppError {
            code: "weather:request".into(),
            message: error.to_string(),
            details: Default::default(),
        })?
        .json()
        .map_err(|error| AppError {
            code: "weather:decode".into(),
            message: error.to_string(),
            details: Default::default(),
        })?;

    let city = reverse_geocode(&client, location);
    let code = response.current.weather_code;

    Ok(PanelWeather {
        temperature: round1(response.current.temperature_2m),
        weather_code: code,
        weather_text: wmo_text(code).to_string(),
        temp_max: response.daily.temperature_2m_max.first().copied().map(round1),
        temp_min: response.daily.temperature_2m_min.first().copied().map(round1),
        city,
        source: location.source.clone(),
        accuracy: location.accuracy,
    })
}

fn reverse_geocode(client: &reqwest::blocking::Client, location: &Location) -> String {
    let url = format!(
        "https://api.bigdatacloud.net/data/reverse-geocode-client?latitude={:.4}\
         &longitude={:.4}&localityLanguage=zh",
        location.latitude, location.longitude
    );

    let parsed: ReverseGeocodeResponse = match client.get(&url).send().and_then(|r| r.json()) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("reverse geocode failed: {error}");
            return String::new();
        }
    };

    if !parsed.city.is_empty() {
        return parsed.city;
    }
    if !parsed.locality.is_empty() {
        return parsed.locality;
    }
    // 兜底：取行政层级里 order 最小（最粗）的那一级，通常是省/州。
    parsed
        .locality_info
        .unwrap_or_default()
        .administrative
        .into_iter()
        .min_by_key(|entry| entry.order)
        .map(|entry| entry.name)
        .filter(|name| !name.is_empty())
        .unwrap_or_default()
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

/// WMO 天气码 → 中文现象。表按官方 4677 编码分组写全，
/// 官方未定义的码落到「未知」。
pub fn wmo_text(code: u32) -> &'static str {
    match code {
        0 => "晴",
        1 => "晴间多云",
        2 => "多云",
        3 => "阴",
        45 => "雾",
        48 => "雾凇",
        51 => "小毛毛雨",
        53 => "毛毛雨",
        55 => "大毛毛雨",
        56 => "冻毛毛雨",
        57 => "强冻毛毛雨",
        61 => "小雨",
        63 => "中雨",
        65 => "大雨",
        66 => "冻雨",
        67 => "强冻雨",
        71 => "小雪",
        73 => "中雪",
        75 => "大雪",
        77 => "米雪",
        80 => "阵雨",
        81 => "强阵雨",
        82 => "暴雨",
        85 => "阵雪",
        86 => "强阵雪",
        95 => "雷阵雨",
        96 => "雷阵雨伴冰雹",
        99 => "强雷暴伴冰雹",
        _ => "未知",
    }
}

/// 天气条上的小图标（用字符画，不引入图标文件）。
pub fn wmo_icon(code: u32) -> &'static str {
    match code {
        0 | 1 => "☀",
        2 => "⛅",
        3 => "☁",
        45 | 48 => "≡",
        51..=57 => "🌦",
        61..=67 => "🌧",
        71..=77 => "❄",
        80..=82 => "🌧",
        85 | 86 => "🌨",
        95..=99 => "⛈",
        _ => "·",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wmo_text_covers_common_codes() {
        assert_eq!(wmo_text(0), "晴");
        assert_eq!(wmo_text(2), "多云");
        assert_eq!(wmo_text(61), "小雨");
        assert_eq!(wmo_text(95), "雷阵雨");
        assert_eq!(wmo_text(1234), "未知");
    }

    #[test]
    fn wmo_icon_falls_back_for_unknown_code() {
        assert_eq!(wmo_icon(0), "☀");
        assert_eq!(wmo_icon(4242), "·");
    }

    #[test]
    fn round1_keeps_one_decimal() {
        assert_eq!(round1(17.14), 17.1);
        assert_eq!(round1(17.16), 17.2);
    }

    #[test]
    fn missing_location_is_an_error_not_a_guess() {
        let location = Location {
            latitude: f64::NAN,
            longitude: f64::NAN,
            accuracy: None,
            source: "none".into(),
        };
        let error = fetch_weather(&location).unwrap_err();
        assert_eq!(error.code, "weather:noLocation");
    }
}
