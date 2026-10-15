//! Bounded image transforms for the upload routes (profile avatars, forum media).
//!
//! Every transform reads the image header first and rejects oversized
//! dimensions before a single pixel is decoded, decodes under `image::Limits`,
//! and runs decode + resize + encode on tokio's blocking pool behind a small
//! global semaphore. Uploads therefore never occupy the request workers (the Pi
//! runs only three) and at most a couple of transforms hold memory at once.

use std::io::Cursor;
use std::sync::OnceLock;
use std::time::Duration;

use image::{DynamicImage, ExtendedColorType, ImageEncoder, ImageReader, Limits};
use tokio::sync::Semaphore;

/// Size policy for one upload kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Policy {
    pub max_width: u32,
    pub max_height: u32,
    /// Decoder allocation ceiling (`image::Limits::max_alloc`).
    pub max_alloc: u64,
}

/// Profile pictures: 4096x4096 source at most, 64 MiB decoder budget.
pub const AVATAR: Policy = Policy {
    max_width: 4096,
    max_height: 4096,
    max_alloc: 64 * 1024 * 1024,
};

/// Forum media: 8000x8000 source at most, 128 MiB decoder budget.
pub const FORUM: Policy = Policy {
    max_width: 8000,
    max_height: 8000,
    max_alloc: 128 * 1024 * 1024,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fit {
    /// Centre-crop cover to exactly `width x height`.
    Cover { width: u32, height: u32 },
    /// Fit inside `max x max` without enlargement.
    Inside { max: u32 },
}

/// A lossless WebP and its pixel size.
#[derive(Clone, Debug)]
pub struct Encoded {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TransformError {
    /// Header dimensions, or the decoder allocation, are over the policy.
    TooLarge { width: u32, height: u32 },
    /// Not a decodable JPEG/PNG/WebP/GIF.
    Unsupported,
    /// Every transform slot stayed busy for the whole queue timeout.
    Busy,
    /// Encoding, or the blocking task itself, failed.
    Failed(String),
}

impl TransformError {
    /// The HTTP status a route answers with.
    pub fn status(&self) -> u16 {
        match self {
            TransformError::TooLarge { .. } => 413,
            TransformError::Unsupported => 400,
            TransformError::Busy => 503,
            TransformError::Failed(_) => 500,
        }
    }
}

const DEFAULT_SLOTS: usize = 2;
const QUEUE_TIMEOUT: Duration = Duration::from_secs(20);

/// Global transform slots (`POKOIN_IMAGE_TRANSFORM_SLOTS`, 1-8, default 2).
fn slots() -> &'static Semaphore {
    static SLOTS: OnceLock<Semaphore> = OnceLock::new();
    SLOTS.get_or_init(|| {
        let permits = std::env::var("POKOIN_IMAGE_TRANSFORM_SLOTS")
            .ok()
            .and_then(|value| value.trim().parse::<usize>().ok())
            .filter(|value| (1..=8).contains(value))
            .unwrap_or(DEFAULT_SLOTS);
        Semaphore::new(permits)
    })
}

fn reader(source: &[u8]) -> Result<ImageReader<Cursor<&[u8]>>, TransformError> {
    let reader = ImageReader::new(Cursor::new(source))
        .with_guessed_format()
        .map_err(|_| TransformError::Unsupported)?;
    if reader.format().is_none() {
        return Err(TransformError::Unsupported);
    }
    Ok(reader)
}

/// Header-only dimensions. Over-policy images are rejected here, before any
/// pixel buffer is allocated.
pub fn probe(source: &[u8], policy: Policy) -> Result<(u32, u32), TransformError> {
    let (width, height) = reader(source)?
        .into_dimensions()
        .map_err(|_| TransformError::Unsupported)?;
    if width == 0 || height == 0 {
        return Err(TransformError::Unsupported);
    }
    if width > policy.max_width || height > policy.max_height {
        return Err(TransformError::TooLarge { width, height });
    }
    Ok((width, height))
}

/// Probe, limited decode, resize, lossless WebP — on the calling thread.
/// Async handlers use [`transform`], which runs this on the blocking pool.
pub fn transform_blocking(source: &[u8], policy: Policy, fit: Fit) -> Result<Encoded, TransformError> {
    let (width, height) = probe(source, policy)?;
    let mut reader = reader(source)?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(policy.max_width);
    limits.max_image_height = Some(policy.max_height);
    limits.max_alloc = Some(policy.max_alloc);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|error| match error {
        image::ImageError::Limits(_) => TransformError::TooLarge { width, height },
        _ => TransformError::Unsupported,
    })?;
    encode_webp(&resize(decoded, fit))
}

/// [`transform_blocking`] on tokio's blocking pool behind the global slots.
/// The header probe runs first on the caller, so an oversized image is
/// rejected without queueing. The slot is held by the blocking task itself: a
/// client that disconnects mid-transform does not free it early.
pub async fn transform(source: Vec<u8>, policy: Policy, fit: Fit) -> Result<Encoded, TransformError> {
    probe(&source, policy)?;
    let permit = tokio::time::timeout(QUEUE_TIMEOUT, slots().acquire())
        .await
        .map_err(|_| TransformError::Busy)?
        .map_err(|_| TransformError::Busy)?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        transform_blocking(&source, policy, fit)
    })
    .await
    .map_err(|error| TransformError::Failed(error.to_string()))?
}

fn resize(image: DynamicImage, fit: Fit) -> DynamicImage {
    use image::imageops::FilterType::Lanczos3;
    let (width, height) = (image.width() as f64, image.height() as f64);
    match fit {
        Fit::Cover { width: target_w, height: target_h } => {
            let scale = f64::max(target_w as f64 / width, target_h as f64 / height);
            prescale(image, scale).resize_to_fill(target_w, target_h, Lanczos3)
        }
        Fit::Inside { max } => {
            if image.width() <= max && image.height() <= max {
                return image;
            }
            let scale = f64::min(max as f64 / width, max as f64 / height);
            prescale(image, scale).resize(max, max, Lanczos3)
        }
    }
}

/// Big downscales first area-reduce to twice the target (`thumbnail_exact`,
/// integer sampling into an output-sized buffer), so Lanczos3 filters a small
/// image instead of allocating float rows for a 40 MP source.
fn prescale(image: DynamicImage, scale: f64) -> DynamicImage {
    if scale >= 0.5 {
        return image;
    }
    let width = ((image.width() as f64 * scale * 2.0).ceil() as u32).max(1);
    let height = ((image.height() as f64 * scale * 2.0).ceil() as u32).max(1);
    image.thumbnail_exact(width, height)
}

fn encode_webp(image: &DynamicImage) -> Result<Encoded, TransformError> {
    let (width, height) = (image.width(), image.height());
    let mut bytes = Vec::new();
    let encoder = image::codecs::webp::WebPEncoder::new_lossless(&mut bytes);
    let written = if image.color().has_alpha() {
        encoder.write_image(image.to_rgba8().as_raw(), width, height, ExtendedColorType::Rgba8)
    } else {
        encoder.write_image(image.to_rgb8().as_raw(), width, height, ExtendedColorType::Rgb8)
    };
    written.map_err(|error| TransformError::Failed(error.to_string()))?;
    Ok(Encoded { bytes, width, height })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut out = Vec::new();
        DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(width, height, image::Rgba([200, 10, 10, 255])))
            .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xffff_ffffu32;
        for byte in bytes {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
            }
        }
        !crc
    }

    fn push_chunk(out: &mut Vec<u8>, kind: &[u8], data: &[u8]) {
        let mut chunk = kind.to_vec();
        chunk.extend_from_slice(data);
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend_from_slice(&chunk);
        out.extend_from_slice(&crc32(&chunk).to_be_bytes());
    }

    /// A ~60-byte PNG whose IHDR claims `width x height` and whose IDAT is
    /// four junk bytes: the header parses, decoding it can only fail.
    fn header_only_png(width: u32, height: u32) -> Vec<u8> {
        let mut ihdr = width.to_be_bytes().to_vec();
        ihdr.extend_from_slice(&height.to_be_bytes());
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
        let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
        push_chunk(&mut out, b"IHDR", &ihdr);
        push_chunk(&mut out, b"IDAT", &[0, 0, 0, 0]);
        push_chunk(&mut out, b"IEND", &[]);
        out
    }

    #[test]
    fn oversized_header_is_rejected_without_decoding() {
        let bomb = header_only_png(100_000, 100_000);
        // The header parses, and decoding it would fail: TooLarge proves the
        // rejection happened on the header, before the decoder ran.
        assert_eq!(reader(&bomb).unwrap().into_dimensions().unwrap(), (100_000, 100_000));
        assert!(reader(&bomb).unwrap().decode().is_err());
        let expected = TransformError::TooLarge { width: 100_000, height: 100_000 };
        assert_eq!(probe(&bomb, FORUM), Err(expected.clone()));
        assert_eq!(transform_blocking(&bomb, AVATAR, Fit::Cover { width: 256, height: 256 }).unwrap_err(), expected);
        assert_eq!(expected.status(), 413);
        // One side over is enough; exactly at the cap is allowed.
        assert!(matches!(probe(&header_only_png(4097, 10), AVATAR), Err(TransformError::TooLarge { .. })));
        assert_eq!(probe(&header_only_png(4096, 4096), AVATAR), Ok((4096, 4096)));
        assert_eq!(probe(&header_only_png(8000, 8000), FORUM), Ok((8000, 8000)));
    }

    #[test]
    fn decoder_allocation_limit_maps_to_too_large() {
        let tight = Policy { max_width: 4096, max_height: 4096, max_alloc: 1024 };
        assert_eq!(
            transform_blocking(&png(100, 100), tight, Fit::Inside { max: 1600 }).unwrap_err(),
            TransformError::TooLarge { width: 100, height: 100 }
        );
    }

    #[test]
    fn junk_is_unsupported() {
        assert_eq!(probe(b"not an image", AVATAR), Err(TransformError::Unsupported));
        assert_eq!(TransformError::Unsupported.status(), 400);
    }

    #[test]
    fn cover_and_inside_sizes() {
        let avatar = transform_blocking(&png(1, 1), AVATAR, Fit::Cover { width: 256, height: 256 }).unwrap();
        assert_eq!(&avatar.bytes[..4], b"RIFF");
        assert_eq!(&avatar.bytes[8..12], b"WEBP");
        assert_eq!((avatar.width, avatar.height), (256, 256));
        let decoded = image::load_from_memory(&avatar.bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (256, 256));

        // Large downscale goes through the area prescale, still exact output.
        let wide = transform_blocking(&png(4000, 1000), FORUM, Fit::Inside { max: 1600 }).unwrap();
        assert_eq!((wide.width, wide.height), (1600, 400));
        let cover = transform_blocking(&png(3000, 1200), AVATAR, Fit::Cover { width: 256, height: 256 }).unwrap();
        assert_eq!((cover.width, cover.height), (256, 256));

        // Small images are not enlarged.
        let small = transform_blocking(&png(2, 3), FORUM, Fit::Inside { max: 1600 }).unwrap();
        assert_eq!((small.width, small.height), (2, 3));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn async_transform_runs_off_the_worker_and_frees_its_slot() {
        let before = slots().available_permits();
        let jobs = (0..6).map(|_| transform(png(64, 64), FORUM, Fit::Inside { max: 32 }));
        for result in futures_join(jobs).await {
            let encoded = result.unwrap();
            assert_eq!((encoded.width, encoded.height), (32, 32));
        }
        assert_eq!(slots().available_permits(), before);
        // Oversized never takes a slot.
        assert!(matches!(
            transform(header_only_png(9000, 10), FORUM, Fit::Inside { max: 1600 }).await,
            Err(TransformError::TooLarge { .. })
        ));
        assert_eq!(slots().available_permits(), before);
    }

    async fn futures_join<F: std::future::Future + Send + 'static>(jobs: impl Iterator<Item = F>) -> Vec<F::Output>
    where
        F::Output: Send + 'static,
    {
        let handles: Vec<_> = jobs.map(tokio::spawn).collect();
        let mut out = Vec::new();
        for handle in handles {
            out.push(handle.await.unwrap());
        }
        out
    }
}
