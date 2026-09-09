function handler(event) {
  var request = event.request;

  // Serve extensionless routes from an index document.
  if (request.uri.endsWith('/')) {
    request.uri += 'index.html';
  }

  // A viewer-request function may return a response without calling the origin.
  if (request.uri === '/private') {
    return {
      statusCode: 302,
      statusDescription: 'Found',
      headers: {
        location: { value: '/login' },
        'cache-control': { value: 'no-store' }
      }
    };
  }

  request.headers['x-local-edge'] = { value: 'viewer-request' };
  return request;
}
