'use client';

import { useState, useRef } from 'react';

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB in bytes
const BACKEND_URL = 'http://127.0.0.1:8000';
const MAX_RETRIES = 2;

interface PresignedPutPart {
  part_number: number;
  url: string;
}

interface StartUploadResponse {
  parts: PresignedPutPart[];
  video: string;
}

interface UploadStatus {
  status: string;
  video: string;
}

interface CompletePart {
  ETag: string;
  PartNumber: number;
}

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [videoUid, setVideoUid] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const cancelledRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const chunkFile = (file: File): Blob[] => {
    const chunks: Blob[] = [];
    let start = 0;
    
    while (start < file.size) {
      const end = Math.min(start + CHUNK_SIZE, file.size);
      chunks.push(file.slice(start, end));
      start = end;
    }
    
    return chunks;
  };

  const uploadChunkToS3 = async (
    chunk: Blob,
    part: PresignedPutPart,
    retryCount = 0
  ): Promise<string> => {
    try {
      console.log(`Uploading chunk ${part.part_number} to: ${part.url.substring(0, 100)}...`);

      // For PUT requests, send the chunk directly as the request body
      // The presigned URL already contains all necessary query parameters (uploadId, partNumber, signature, etc.)
      const response = await fetch(part.url, {
        method: 'PUT',
        body: chunk,
        // Don't set Content-Type header - let the browser set it automatically
        // Some S3-compatible services require specific content types
      });

      // Log response for debugging
      console.log(`Chunk ${part.part_number} response:`, {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      });
      
      if (!response.ok) {
        // Read error response body
        const responseText = await response.text();
        console.error(`Chunk ${part.part_number} upload failed:`, {
          status: response.status,
          statusText: response.statusText,
          response: responseText,
          headers: Object.fromEntries(response.headers.entries())
        });
        throw new Error(`Failed to upload chunk ${part.part_number}: ${response.status} ${response.statusText}${responseText ? ' - ' + responseText : ''}`);
      }
      
      // For PUT requests, the response body is usually empty for successful uploads
      // ETag is always in the response headers for S3 multipart uploads

      // Extract ETag from response headers
      // S3 multipart upload PUT requests return ETag in the 'ETag' header
      // The ETag may be quoted, so we need to remove quotes
      let etag = response.headers.get('ETag') || 
                 response.headers.get('etag') || 
                 response.headers.get('Etag') || '';
      
      // Remove quotes from ETag if present (S3 ETags are often quoted with double quotes)
      etag = etag.replace(/^["']|["']$/g, '').trim();
      
      if (!etag) {
        console.error(`Failed to extract ETag from chunk ${part.part_number}:`, {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          allHeaders: Array.from(response.headers.entries())
        });
        throw new Error(`Failed to extract ETag from chunk ${part.part_number} response. Status: ${response.status}. Headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`);
      }
      
      console.log(`Chunk ${part.part_number} uploaded successfully, ETag: ${etag}`);
      return etag;
    } catch (error) {
      if (retryCount < MAX_RETRIES) {
        console.log(`Retrying chunk ${part.part_number}, attempt ${retryCount + 1}`);
        return uploadChunkToS3(chunk, part, retryCount + 1);
      }
      throw error;
    }
  };

  const startUpload = async (fileName: string, totalParts: number, contentType?: string): Promise<StartUploadResponse> => {
    const uploadId = `upload-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    
    const response = await fetch(`${BACKEND_URL}/api/v2/my/projects/upload/start/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        upload_id: uploadId,
        file_name: fileName,
        total_parts: totalParts.toString(),
        ...(contentType && { content_type: contentType }),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to start upload: ${response.statusText} - ${errorText}`);
    }

    return response.json();
  };

  const cancelUpload = async (videoUid: string): Promise<void> => {
    try {
      const response = await fetch(`${BACKEND_URL}/api/v2/my/projects/upload/${videoUid}/cancel/`, {
        method: 'POST',
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to cancel upload: ${response.statusText} - ${errorText}`);
      }
    } catch (error) {
      console.error('Error canceling upload:', error);
      // Don't throw - we still want to mark as cancelled locally
    }
  };

  const completeUpload = async (videoUid: string, parts: CompletePart[]): Promise<void> => {
    const response = await fetch(`${BACKEND_URL}/api/v2/my/projects/upload/${videoUid}/complete/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        parts: parts,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to complete upload: ${response.statusText} - ${errorText}`);
    }
  };

  const checkStatus = async (videoUid: string): Promise<UploadStatus> => {
    const response = await fetch(`${BACKEND_URL}/api/v2/my/projects/upload/${videoUid}/status/`, {
      method: 'GET',
    });

    if (!response.ok) {
      throw new Error(`Failed to check status: ${response.statusText}`);
    }

    return response.json();
  };

  const pollStatus = async (videoUid: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      const poll = async () => {
        // Check if cancelled before polling
        if (cancelledRef.current) {
          resolve();
          return;
        }

        try {
          const statusData = await checkStatus(videoUid);
          setStatus(`Status: ${statusData.status}`);
          
          if (statusData.status === 'completed') {
            setProgress(100);
            resolve();
          } else if (cancelledRef.current) {
            // If cancelled during polling, stop
            resolve();
          } else {
            // Poll again after 5 seconds
            setTimeout(poll, 5000);
          }
        } catch (error) {
          if (cancelledRef.current) {
            resolve();
          } else {
            reject(error);
          }
        }
      };
      
      // Start polling after 3 seconds
      setTimeout(poll, 3000);
    });
  };

  const handleUpload = async () => {
    if (!file) {
      setError('Please select a file');
      return;
    }

    setUploading(true);
    setError('');
    setStatus('Preparing upload...');
    setProgress(0);
    setCancelled(false);
    cancelledRef.current = false;
    setVideoUid(null);

    try {
      // Step 1: Chunk the file
      const chunks = chunkFile(file);
      const totalParts = chunks.length;
      setStatus(`Chunking file into ${totalParts} parts...`);
      setProgress(5);

      // Step 2: Start upload and get presigned URLs
      const startResponse = await startUpload(file.name, totalParts, file.type);
      setVideoUid(startResponse.video);
      setStatus(`Received ${startResponse.parts.length} presigned URLs`);
      setProgress(10);

      // Check if cancelled before starting chunk uploads
      if (cancelledRef.current) {
        return;
      }

      // Step 3: Upload each chunk to S3
      // Note: We don't cancel ongoing uploads - let them finish
      const completeParts: CompletePart[] = [];
      const uploadProgressStep = 80 / totalParts; // 80% for chunk uploads

      for (let i = 0; i < chunks.length; i++) {
        // Check if cancelled before each chunk
        if (cancelledRef.current) {
          setStatus('Upload cancelled. Finishing current chunk uploads...');
          break;
        }

        const chunk = chunks[i];
        const part = startResponse.parts[i];
        
        setStatus(`Uploading chunk ${i + 1}/${totalParts}...`);
        
        const etag = await uploadChunkToS3(chunk, part);
        completeParts.push({
          ETag: etag,
          PartNumber: part.part_number,
        });

        setProgress(10 + (i + 1) * uploadProgressStep);
      }

      // If cancelled, don't complete the upload
      if (cancelledRef.current) {
        setStatus('Upload cancelled');
        return;
      }

      // Sort parts by PartNumber (S3 requires parts to be in order)
      completeParts.sort((a, b) => a.PartNumber - b.PartNumber);
      
      console.log('Completing upload with parts:', completeParts.map(p => ({
        PartNumber: p.PartNumber,
        ETag: p.ETag.substring(0, 20) + '...'
      })));

      // Step 4: Complete the upload
      setStatus('Completing upload...');
      setProgress(90);
      await completeUpload(startResponse.video, completeParts);

      // Step 5: Keep progress at 99% and poll for status
      setProgress(99);
      setStatus('Waiting for processing...');
      await pollStatus(startResponse.video);

      if (!cancelledRef.current) {
        setStatus('Upload completed successfully!');
      }
    } catch (err) {
      if (!cancelledRef.current) {
        const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
        setError(errorMessage);
        setStatus('Upload failed');
        console.error('Upload error:', err);
      }
    } finally {
      setUploading(false);
    }
  };

  const handleCancel = async () => {
    if (!videoUid || !uploading) {
      return;
    }

    setCancelled(true);
    cancelledRef.current = true;
    setStatus('Cancelling upload...');
    
    // Call cancel API but don't wait for it - let ongoing uploads finish
    cancelUpload(videoUid).catch(console.error);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
      setError('');
      setStatus('');
      setProgress(0);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-2xl rounded-lg bg-white p-8 shadow-lg">
        <h1 className="mb-6 text-3xl font-bold text-gray-900">File Upload</h1>
        
        <div className="mb-6">
          <label className="mb-2 block text-sm font-medium text-gray-700">
            Select File
          </label>
          <input
            ref={fileInputRef}
            type="file"
            onChange={handleFileChange}
            disabled={uploading}
            className="block w-full text-sm text-gray-500 file:mr-4 file:rounded-md file:border-0 file:bg-blue-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-blue-700 hover:file:bg-blue-100 disabled:opacity-50"
          />
        </div>

        {file && (
          <div className="mb-6 rounded-md bg-gray-50 p-4">
            <p className="text-sm text-gray-600">
              <span className="font-medium">File:</span> {file.name}
            </p>
            <p className="text-sm text-gray-600">
              <span className="font-medium">Size:</span> {(file.size / (1024 * 1024)).toFixed(2)} MB
            </p>
            <p className="text-sm text-gray-600">
              <span className="font-medium">Chunks:</span> {Math.ceil(file.size / CHUNK_SIZE)}
            </p>
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-md bg-red-50 p-4">
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}

        {status && (
          <div className="mb-4 rounded-md bg-blue-50 p-4">
            <p className="text-sm text-blue-800">{status}</p>
          </div>
        )}

        {progress > 0 && (
          <div className="mb-6">
            <div className="mb-2 flex justify-between text-sm">
              <span className="text-gray-600">Progress</span>
              <span className="font-medium text-gray-900">{Math.round(progress)}%</span>
            </div>
            <div className="h-4 w-full overflow-hidden rounded-full bg-gray-200">
              <div
                className="h-full bg-blue-600 transition-all duration-300 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

        <div className="flex gap-4">
          <button
            onClick={handleUpload}
            disabled={!file || uploading}
            className="flex-1 rounded-md bg-blue-600 px-4 py-2 font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {uploading ? 'Uploading...' : 'Upload File'}
          </button>
          {uploading && (
            <button
              onClick={handleCancel}
              className="rounded-md bg-red-600 px-4 py-2 font-medium text-white transition-colors hover:bg-red-700"
            >
              Cancel
            </button>
          )}
        </div>
        </div>
    </div>
  );
}
