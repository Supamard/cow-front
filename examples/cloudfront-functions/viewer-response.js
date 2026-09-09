function handler(event) {
  var response = event.response;

  response.headers['x-content-type-options'] = { value: 'nosniff' };
  response.headers['referrer-policy'] = { value: 'same-origin' };
  response.headers['x-local-edge'] = { value: 'viewer-response' };

  return response;
}
