//! Native window capture (Windows). Used to screenshot a web page rendered in a
//! temporary webview window as "done" evidence. PrintWindow with
//! PW_RENDERFULLCONTENT is the documented way to capture WebView2 / Chromium
//! content (a plain GDI BitBlt returns black for GPU-composited surfaces).

use crate::error::CommandError;

/// Capture the webview window `label` to `<root>/.maestro/shots/<name>` (PNG).
/// Returns the path relative to `root`.
#[cfg(windows)]
#[tauri::command]
pub fn capture_window(
    app: tauri::AppHandle,
    label: String,
    root: String,
    name: String,
) -> Result<String, CommandError> {
    use tauri::Manager;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows::Win32::UI::WindowsAndMessaging::{GetClientRect, PW_RENDERFULLCONTENT};

    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(CommandError::Failed("invalid name".into()));
    }

    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| CommandError::Failed("window not found".into()))?;
    let raw = window
        .hwnd()
        .map_err(|e| CommandError::Failed(format!("hwnd: {e}")))?;
    let hwnd = HWND(raw.0 as *mut core::ffi::c_void);

    let buf;
    let w;
    let h;
    unsafe {
        let mut rc = RECT::default();
        GetClientRect(hwnd, &mut rc).map_err(|e| CommandError::Failed(format!("rect: {e}")))?;
        w = (rc.right - rc.left).max(1);
        h = (rc.bottom - rc.top).max(1);

        let hdc_win = GetDC(Some(hwnd));
        let hdc_mem = CreateCompatibleDC(Some(hdc_win));
        let hbm = CreateCompatibleBitmap(hdc_win, w, h);
        let old = SelectObject(hdc_mem, HGDIOBJ(hbm.0));

        let printed = PrintWindow(hwnd, hdc_mem, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT));

        let mut bmi = BITMAPINFO::default();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = w;
        bmi.bmiHeader.biHeight = -h; // top-down rows
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB.0;

        let mut pixels = vec![0u8; (w * h * 4) as usize];
        let lines = GetDIBits(
            hdc_mem,
            hbm,
            0,
            h as u32,
            Some(pixels.as_mut_ptr() as *mut core::ffi::c_void),
            &mut bmi,
            DIB_RGB_COLORS,
        );

        let _ = SelectObject(hdc_mem, old);
        let _ = DeleteObject(HGDIOBJ(hbm.0));
        let _ = DeleteDC(hdc_mem);
        ReleaseDC(Some(hwnd), hdc_win);

        if !printed.as_bool() || lines == 0 {
            return Err(CommandError::Failed("capture failed".into()));
        }
        // BGRA -> RGBA, force opaque (PrintWindow leaves alpha at 0).
        for px in pixels.chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 255;
        }
        buf = pixels;
    }

    let dir = std::path::Path::new(&root).join(".maestro").join("shots");
    std::fs::create_dir_all(&dir).map_err(|e| CommandError::Failed(e.to_string()))?;
    let path = dir.join(&name);
    let file = std::fs::File::create(&path).map_err(|e| CommandError::Failed(e.to_string()))?;
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w as u32, h as u32);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    let mut writer = enc
        .write_header()
        .map_err(|e| CommandError::Failed(e.to_string()))?;
    writer
        .write_image_data(&buf)
        .map_err(|e| CommandError::Failed(e.to_string()))?;

    Ok(format!(".maestro\\shots\\{name}"))
}

#[cfg(not(windows))]
#[tauri::command]
pub fn capture_window(
    _app: tauri::AppHandle,
    _label: String,
    _root: String,
    _name: String,
) -> Result<String, CommandError> {
    Err(CommandError::Failed("screenshots are Windows-only".into()))
}
