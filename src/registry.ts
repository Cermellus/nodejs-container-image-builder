// Copyright 2019 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
import * as crypto from 'crypto';
// cant use teeny-request because typings on return value.
import * as request from 'request';
import {Response} from 'request';
import {Readable} from 'stream';
import * as urlModule from 'url';

import {DockerAuthResult} from './credentials-helper';

// https://docs.docker.com/registry/spec/api/
// https://github.com/opencontainers/distribution-spec/blob/master/spec.md

export class RegistryClient {
  _auth: DockerAuthResult;
  _registry: string;
  _repository: string;

  constructor(registry: string, repository: string, auth: DockerAuthResult) {
    this._auth = auth;          // return from getToken
    this._registry = registry;  // gcr.io
    this._repository = repository;
  }

  tags(): Promise<TagResult> {
    return new Promise((resolve, reject) => {
      request.get(
          {
            url: `https://${this._registry}/v2/${this._repository}/tags/list`,
            headers: {
              Authorization: this.authHeader(),
              Accept: 'application/vnd.docker.distribution.manifest.v2+json'
            }
          },
          (err: Error, res: Response, body: Buffer) => {
            if (err) return reject(err);
            try {
              return resolve(JSON.parse(body + '') as TagResult);
            } catch (e) {
              reject(e);
            }
          });
    });
  }

  manifest(tag: string): Promise<ManifestV2> {
    return new Promise((resolve, reject) => {
      const url =
          `https://${this._registry}/v2/${this._repository}/manifests/${tag}`;

      request.get(
          url, {
            headers: {
              Authorization: this.authHeader(),
              Accept: 'application/vnd.docker.distribution.manifest.v2+json'
            }
          },
          (err: Error, res: Response, body: Buffer) => {
            if (err) return reject(err);
            try {
              const parsed = JSON.parse(body + '');

              if (res.statusCode === 200 && parsed.config) {
                resolve(parsed);
              } else {
                reject(new Error(
                    'unexpected status code ' + res.statusCode +
                    ' from docker registry. response ' + body));
              }
            } catch (e) {
              reject(e);
            }
          });
    });
  }
  // upload a manifest and the only way to set a tag on a manifest
  manifestUpload(tag: string|false, manifest: Buffer|{}):
      Promise<{status: number, digest: string, body: Buffer}> {
    return new Promise((resolve, reject) => {
      const manifestBuf = Buffer.isBuffer(manifest) ?
          manifest :
          Buffer.from(JSON.stringify(manifest));

      const digest = 'sha256:' +
          crypto.createHash('sha256').update(manifestBuf).digest('hex');
      if (!tag) {
        // if for some reason you really dont want a tag on this version
        // we need to use the digest as the ref
        tag = digest;
      }

      const req = request.put(
          `https://${this._registry}/v2/${this._repository}/manifests/${tag}`, {
            headers: {
              Authorization: this.authHeader(),
              // TODO: read content type from mediaType field of manifest.
              'content-type':
                  'application/vnd.docker.distribution.manifest.v2+json'
            }
          },
          (err: Error, res: Response, body: Buffer) => {
            if (err) {
              return reject(err);
            }

            if (res.statusCode !== 200 && res.statusCode !== 201) {
              return reject(new Error(
                  'unexpected status code ' + res.statusCode + ' ' + body));
            }

            resolve({
              status: res.statusCode,
              digest,  // res.headers['docker-content-digest'],
              body
            });
          });


      req.end(manifestBuf);
    });
  }

  blobExists(digest: string): Promise<boolean> {
    const url =
        `https://${this._registry}/v2/${this._repository}/blobs/${digest}`;
    const opts = {url, headers: {Authorization: this.authHeader()}};

    return new Promise((resolve, reject) => {
      request.head(opts, (err: Error, res: Response) => {
        if (err) reject(err);
        resolve(res.statusCode === 200);
      });
    });
  }

  blob(digest: string, stream?: false|undefined): Promise<Buffer>;
  blob(digest: string, stream?: true): Promise<Readable>;
  blob(digest: string, stream?: boolean): Promise<Buffer|Readable> {
    return new Promise((resolve, reject) => {
      const url =
          `https://${this._registry}/v2/${this._repository}/blobs/${digest}`;
      let loop = 0;
      const fetch = (url: string) => {
        if (loop++ === 5) {
          return reject(new Error('redirect looped 5 times ' + url));
        }

        const opts = {
          url,
          headers: {Authorization: this.authHeader()},
          followRedirect: false
        };

        if (stream) {
          const req = request.get(opts);
          req.on('response', (res: Response) => {
            if (res.headers.location) {
              res.on('error', () => {});
              res.on('data', () => {});
              return fetch(urlModule.resolve(url, res.headers.location));
            }

            res.on('error', reject);
            if (res.statusCode !== 200) {
              res.on('data', () => {});
              reject(new Error(
                  'unexpected status code ' + res.statusCode +
                  ' streaming blob'));
              return;
            }
            res.pause();
            resolve(res);
          });
          req.on('error', reject);
          return;
        }
        request.get(opts, (err: Error, res: Response, body: Buffer) => {
          if (err) return reject(err);

          if (res.headers.location) {
            return fetch(urlModule.resolve(url, res.headers.location));
          }

          if (res.statusCode !== 200) {
            return reject(new Error(
                'unexpected status code ' + res.statusCode + ' ' + body));
          }
          return resolve(body);
        });
      };
      fetch(url);
    });
  }

  upload(blob: Readable|Buffer, contentLength?: number, digest?: string):
      Promise<{contentLength: number, digest: string}> {
    if (!isBuffer(blob)) {
      blob.pause();
    } else {
      if (!contentLength) contentLength = blob.length;
      if (!digest) {
        digest =
            'sha256:' + crypto.createHash('sha256').update(blob).digest('hex');
      }
    }

    return new Promise((resolve, reject) => {
      request.post(
          {
            url: `https://${this._registry}/v2/${
                this._repository}/blobs/uploads/`,
            headers: {Authorization: this.authHeader(), 'Content-Length': 0}
          },
          (err: Error, res: Response, body?: Buffer) => {
            if (err) {
              return reject(err);
            }

            // TODO: parse the location header instead of the legacy
            // docker-upload-uuid see
            // https://github.com/opencontainers/distribution-spec/pull/38 for
            // context (note from jonjohnson@)
            let uuid = res.headers['docker-upload-uuid'];

            if (!uuid) {
              return reject(new Error(
                  'request to start upload did not provide uuid in header docker-upload-uuid.'));
            }

            if (contentLength && digest) {
              const putReq = request.put(
                  {
                    url: `https://${this._registry}/v2/${
                        this._repository}/blobs/uploads/${uuid}?digest=${
                        digest}`,
                    headers: {
                      Authorization: this.authHeader(),
                      'Content-Length': contentLength,
                      'Content-Type': 'application/octet-stream'
                    }
                  },
                  (err: Error, res: Response, body?: Buffer) => {
                    if (err) {
                      return reject(err);
                    }

                    if (res.statusCode !== 201) {
                      return reject(new Error(
                          'unexpected status code ' + res.statusCode +
                          ' for upload.'));
                    }

                    resolve({
                      contentLength: contentLength! + 0,
                      digest: res.headers['docker-content-digest'] + ''
                    });
                  });

              if (!isBuffer(blob)) {
                blob.pipe(putReq);
              } else {
                putReq.end(blob);
              }
              return;
            }

            contentLength = 0;

            const hash = crypto.createHash('sha256');

            const patchReq = request(
                {
                  method: 'PATCH',
                  uri: `https://${this._registry}/v2/${
                      this._repository}/blobs/uploads/${uuid}`,
                  headers: {
                    Authorization: this.authHeader(),
                    'Content-Type': 'application/octet-stream'
                  }
                },
                (err: Error, res: Response) => {
                  uuid = res.headers['docker-upload-uuid'] ?
                      res.headers['docker-upload-uuid'] :
                      uuid;

                  if (err) return reject(err);
                  if (res.statusCode !== 204) {
                    return reject(new Error(
                        'unexpected status code ' + res.statusCode +
                        ' for patch upload'));
                  }

                  const digest = 'sha256:' + hash.digest('hex');

                  const resp = request(
                      {
                        method: 'PUT',
                        url: `https://${this._registry}/v2/${
                            this._repository}/blobs/uploads/${uuid}?digest=${
                            digest}`,
                        headers: {
                          Authorization: this.authHeader(),
                          'Content-Length': 0,
                          'Content-Type': 'application/octet-stream'
                        }
                      },
                      (err: Error, res: Response, body: Buffer) => {
                        // console.error(err,res.statusCode,res.headers,body+'')

                        if (err) return reject(err);
                        if (res.statusCode !== 201) {
                          return reject(new Error(
                              'unexpected status code ' + res.statusCode +
                              ' for upload finalization'));
                        }

                        resolve({contentLength: contentLength!, digest});
                      });
                  if (resp) resp.end();
                });

            if (isBuffer(blob)) {
              patchReq.end(blob);
              hash.update(blob);
              contentLength += blob.length;
            } else {
              blob.pipe(patchReq);
              blob.resume();
              blob.on('data', (b) => {
                hash.update(b);
                contentLength += b.length;
              });
            }
          });
    });
  }

  mount(digest: string, fromRepository: string) {
    // TODO: mount will have to be able to request another registry. figure out
    // how to send the right auth for this.
    return new Promise((resolve, reject) => {
      request(
          {
            method: 'POST',
            uri: `https://${this._registry}/v2/${
                this._repository}/blobs/uploads?mount=${digest}&from=${
                fromRepository}`,
            headers: {Authorization: this.authHeader(), 'Content-Length': 0}
          },
          (err: Error, res: Response, body: Buffer) => {
            if (err) return reject(err);
            if (res.statusCode !== 201) {
              return reject(new Error(`mount failed for ${digest} from ${
                  fromRepository} to ${this._repository}`));
            }
            // TODO if it cannot mount it responds with a header to upload.
            resolve(body + '');
          });
    });
  }

  private authHeader() {
    if (this._auth.token) {
      return `Bearer ${this._auth.token}`;
    } else {
      return 'Basic ' +
          Buffer.from(this._auth.Username + ':' + this._auth.Secret)
              .toString('base64');
    }
  }

  /*static auth(registry: string, repo: string, token: string): Promise<string>
  { return new Promise((resolve, reject) => { const url = 'https://' + registry
  + '/v2/token?service=gcr.io&scope=' +
          encodeURIComponent(`repository:${repo}:*`);

      const req = request({
        uri: url,
        method: 'GET',
        headers: {
          Authorization:
              'Basic ' + Buffer.from(`_token:${token}`).toString('base64')
        }
      });

      req.on('response', (res: Response) => {
        const bufs: Buffer[] = [];
        res.on('data', (b: Buffer) => bufs.push(b));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(bufs) + '');
            resolve(data.token + '');
          } catch (e) {
            reject(e);
          }
        });
        res.on('error', (e) => {
          reject(e);
        });
      });
    });
  }
  */
  /*
  // probably dont want to run this if you have lots of repos.
  // here for completeness but needs a token with different permissions.
  catalog(): Promise<string> {
    return new Promise((resolve, reject) => {
      request(
          {
            method: 'GET',
            url: `https://gcr.io/v2/_catalog`,  // allow params.
            headers: {Authorization: this.bearerHeader()}
          },
          (err: Error, res: Response, body: Buffer) => {
            if (err) {
              return reject(err);
            } else {
              resolve(body + '');
            }
          });
    });
  }
  */
}


export interface ManifestV2 {
  schemaVersion: number;
  mediaType: string;
  config: Layer;
  layers: Layer[];
}

// todo
export interface ImageConfig {
  rootfs: {diff_ids: string[]};
  config: {
    Hostname: string,
    Domainname: string,
    User: string,
    AttachStdin: boolean,
    AttachStdout: boolean,
    AttachStderr: boolean,
    Tty: boolean,
    OpenStdin: boolean,
    StdinOnce: boolean,
    Env: string[],
    Cmd: string[],
    ArgsEscaped: boolean,
    // no idea what this is for.
    Image: string,
    // TODO: no idea how volumes is supposed to be populated.
    // tslint:disable-next-line:no-any
    Volumes: any,
    WorkingDir: string,
    Entrypoint: null|string,
    // tslint:disable-next-line:no-any
    OnBuild: any,
    // tslint:disable-next-line:no-any
    Labels: any
  };
}

export interface Layer {
  mediaType: string;
  size: number;
  digest: string;
  urls?: string[];
}

// todo
export interface TagResult {
  // tslint:disable-next-line:no-any
  child: any[];
  manifest: {};
  name: string;
  tags: string[];
}

function isBuffer(v: Buffer|Readable): v is Buffer {
  return Buffer.isBuffer(v);
}
