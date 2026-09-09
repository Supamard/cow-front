function handler(event) {
  var request = event.request;

  // Redirect the old public URL: /about.html -> /about
  if (/\.html$/i.test(request.uri)) {
    var location = request.uri.slice(0, -5);
    var query = [];

    // Keep query parameters, including duplicate values.
    for (var name in request.querystring) {
      var item = request.querystring[name];
      var values = item.multiValue || [item];

      for (var i = 0; i < values.length; i++) {
        query.push(encodeURIComponent(name) + '=' + encodeURIComponent(values[i].value));
      }
    }

    if (query.length) {
      location += '?' + query.join('&');
    }

    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: {
        location: { value: location },
        'cache-control': { value: 'no-store' }
      }
    };
  }

  // Keep the browser URL clean while fetching the real .html object.
  if (request.uri === '/') {
    request.uri = '/index.html';
  } else if (request.uri.endsWith('/')) {
    request.uri += 'index.html';
  } else if (!/\.[^/]+$/.test(request.uri)) {
    request.uri += '.html';
  }

  return request;
}
