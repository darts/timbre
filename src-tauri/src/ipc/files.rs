use std::path::PathBuf;

use crate::paths;

const MAX_VOICE_RECORDING_BYTES: usize = 8 * 1024 * 1024;

#[tauri::command]
pub async fn save_voice_recording(wav_bytes: Vec<u8>) -> Result<String, String> {
    validate_wav_recording(&wav_bytes)?;
    let recordings_dir = paths::data_dir().join("recordings");
    std::fs::create_dir_all(&recordings_dir)
        .map_err(|e| format!("voice recordings directory is not available: {e}"))?;

    let path = recordings_dir.join(format!("{}.wav", uuid::Uuid::new_v4()));
    std::fs::write(&path, wav_bytes).map_err(|e| format!("write voice recording: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn export_audio(
    source_path: String,
    destination_path: String,
) -> Result<(), String> {
    let clips_dir = paths::data_dir().join("clips");
    std::fs::create_dir_all(&clips_dir)
        .map_err(|e| format!("generated clips directory is not available: {e}"))?;
    let clips_root = clips_dir
        .canonicalize()
        .map_err(|e| format!("generated clips directory is not available: {e}"))?;
    let source = PathBuf::from(&source_path)
        .canonicalize()
        .map_err(|e| format!("source audio does not exist: {e}"))?;
    if !source.starts_with(&clips_root) {
        return Err("can only export generated audio from the app clips directory".into());
    }
    if source.extension().and_then(|s| s.to_str()) != Some("wav") {
        return Err("only generated WAV files can be exported".into());
    }

    let destination = PathBuf::from(destination_path);
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create export directory: {e}"))?;
    }
    std::fs::copy(&source, &destination)
        .map_err(|e| format!("copy exported audio: {e}"))?;
    Ok(())
}

fn validate_wav_recording(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 44 {
        return Err("recording is too small to be a WAV file".into());
    }
    if bytes.len() > MAX_VOICE_RECORDING_BYTES {
        return Err("recording is too large; keep reference clips under 15 seconds".into());
    }
    if bytes.get(0..4) != Some(b"RIFF") || bytes.get(8..12) != Some(b"WAVE") {
        return Err("recording must be a RIFF/WAVE file".into());
    }

    let mut offset = 12usize;
    let mut saw_fmt = false;
    let mut saw_data = false;
    while offset + 8 <= bytes.len() {
        let chunk_id = &bytes[offset..offset + 4];
        let chunk_len = u32::from_le_bytes([
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        ]) as usize;
        let chunk_start = offset + 8;
        let chunk_end = chunk_start.saturating_add(chunk_len);
        if chunk_end > bytes.len() {
            return Err("recording WAV has a truncated chunk".into());
        }

        if chunk_id == b"fmt " {
            if chunk_len < 16 {
                return Err("recording WAV has an invalid format chunk".into());
            }
            let audio_format = u16::from_le_bytes([bytes[chunk_start], bytes[chunk_start + 1]]);
            let channels = u16::from_le_bytes([bytes[chunk_start + 2], bytes[chunk_start + 3]]);
            let sample_rate = u32::from_le_bytes([
                bytes[chunk_start + 4],
                bytes[chunk_start + 5],
                bytes[chunk_start + 6],
                bytes[chunk_start + 7],
            ]);
            let bits_per_sample =
                u16::from_le_bytes([bytes[chunk_start + 14], bytes[chunk_start + 15]]);
            if audio_format != 1 {
                return Err("recording WAV must use PCM audio".into());
            }
            if channels == 0 || channels > 2 {
                return Err("recording WAV must be mono or stereo".into());
            }
            if !(8_000..=96_000).contains(&sample_rate) {
                return Err("recording WAV has an unsupported sample rate".into());
            }
            if bits_per_sample != 16 {
                return Err("recording WAV must use 16-bit PCM".into());
            }
            saw_fmt = true;
        } else if chunk_id == b"data" {
            if chunk_len == 0 {
                return Err("recording WAV has no audio samples".into());
            }
            saw_data = true;
        }

        offset = chunk_end + (chunk_len % 2);
    }

    if !saw_fmt {
        return Err("recording WAV is missing its format chunk".into());
    }
    if !saw_data {
        return Err("recording WAV is missing its audio data".into());
    }
    Ok(())
}
