//! 3×5 bitmap digits for cell numbers (no font dependency).

use image::{Rgba, RgbaImage};

const DIGITS: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111],
    [0b010, 0b110, 0b010, 0b010, 0b111],
    [0b111, 0b001, 0b111, 0b100, 0b111],
    [0b111, 0b001, 0b111, 0b001, 0b111],
    [0b101, 0b101, 0b111, 0b001, 0b001],
    [0b111, 0b100, 0b111, 0b001, 0b111],
    [0b111, 0b100, 0b111, 0b101, 0b111],
    [0b111, 0b001, 0b010, 0b010, 0b010],
    [0b111, 0b101, 0b111, 0b101, 0b111],
    [0b111, 0b101, 0b111, 0b001, 0b111],
];

/// Draws `n` with its top-left at (x, y), each font pixel `scale`×`scale`.
pub fn draw_number(img: &mut RgbaImage, n: usize, x: u32, y: u32, scale: u32, color: Rgba<u8>) {
    for (i, ch) in n.to_string().bytes().enumerate() {
        let glyph = DIGITS[usize::from(ch - b'0')];
        let gx = x + i as u32 * 4 * scale;
        for (row, bits) in glyph.iter().enumerate() {
            for col in 0..3u32 {
                if bits & (0b100 >> col) == 0 {
                    continue;
                }
                for dy in 0..scale {
                    for dx in 0..scale {
                        let (px, py) = (gx + col * scale + dx, y + row as u32 * scale + dy);
                        if px < img.width() && py < img.height() {
                            img.put_pixel(px, py, color);
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_is_drawn_as_a_centre_column() {
        let mut img = RgbaImage::new(12, 5);
        let ink = Rgba([255, 0, 0, 255]);
        draw_number(&mut img, 1, 0, 0, 1, ink);
        assert_eq!(*img.get_pixel(1, 2), ink);
        assert_eq!(img.get_pixel(0, 2)[3], 0);
    }
}
