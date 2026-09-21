/**
 * WAV encoding helper (16kHz mono)
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeString = (obs: number, s: string) => {
        for (let i = 0; i < s.length; i++) view.setUint8(obs + i, s.charCodeAt(i));
    };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return new Uint8Array(buffer);
}

/**
 * Resamples a Blob to 16kHz mono WAV
 */
export async function blobToWav16k(blob: Blob): Promise<Uint8Array> {
    const arrayBuffer = await blob.arrayBuffer();
    const tempCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);

    const offlineCtx = new OfflineAudioContext(1, audioBuffer.duration * 16000, 16000);
    const sourceNode = offlineCtx.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(offlineCtx.destination);
    sourceNode.start();

    const resampledBuffer = await offlineCtx.startRendering();
    await tempCtx.close();

    return encodeWav(resampledBuffer.getChannelData(0), 16000);
}
