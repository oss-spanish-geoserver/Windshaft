'use strict';

var carto = require('carto');
var debug = require('debug')('windshaft:renderer:torque_factory');
var PSQL = require('cartodb-psql');
var torque_reference = require('torque.js').cartocss_reference;

var RendererParams = require('../renderer_params');

var sql = require('../../utils/sql');
var Renderer = require('./renderer');
var PSQLAdaptor = require('./psql_adaptor');
var PngRenderer = require('./png_renderer');
var BaseAdaptor = require('../base_adaptor');

var SubstitutionTokens = require('../../utils/substitution_tokens');

/// API: initializes the renderer, it should be called once
//
/// @param options initialization options.
///     - sqlClass: class used to access postgres, by default is PSQL
///         the class should provide the following interface
///          - constructor(params) where params should contain:
///            host, port, database, user, password.
///            the class is always constructed with dbParams passed to
///            getRender as-is
///          - query(sql, callback(err, data), readonly)
///            gets an SQL query and return a javascript object with
///            the same structure of a JSON format response from
///            CartoDB-SQL-API, for reference see
///            http://github.com/CartoDB/CartoDB-SQL-API/blob/1.8.2/doc/API.md#json
///            The 'readonly' parameter (false by default) requests
///            that running the query should not allowed to change the database.
///     - dbPoolParams: database connection pool params
///          - size: maximum number of resources to create at any given time
///          - idleTimeout: max milliseconds a resource can go unused before it should be destroyed
///          - reapInterval: frequency to check for idle resources
///
function TorqueFactory(options) {
    // jshint newcap:false
    this.options = options || {};
    this.options = Object.assign({
        sqlClass: PSQLAdaptor(PSQL, options.dbPoolParams)
    }, this.options);

    if (this.options.sqlClass) {
        this.sqlClass = this.options.sqlClass;
    }
}

module.exports = TorqueFactory;
const NAME = 'torque';
module.exports.NAME = NAME;


var formatToRenderer = {
    'torque.json': Renderer,
    'torque.bin': Renderer,
    'json.torque': Renderer,
    'bin.torque': Renderer,
    'png': PngRenderer,
    'torque.png': PngRenderer
};

TorqueFactory.prototype = {
    /// API: renderer name, use for information purposes
    name: NAME,

    /// API: tile formats this module is able to render
    // TODO: deprecate 'json.torque' and 'bin.torque' with 1.18.0
    supported_formats: Object.keys(formatToRenderer),

    getName: function() {
        return this.name;
    },

    supportsFormat: function(format) {
        return !!formatToRenderer[format];
    },

    getAdaptor: function(renderer, format, onTileErrorStrategy) {
        return new BaseAdaptor(renderer, format, onTileErrorStrategy);
    },

    getRenderer: function(mapConfig, format, options, callback) {
        var dbParams = RendererParams.dbParamsFromReqParams(options.params);
        var layer = options.layer;

        if (layer === undefined) {
            return callback(new Error("torque renderer only supports a single layer"));
        }
        if (!formatToRenderer[format]) {
            return callback(new Error("format not supported: " + format));
        }
        var layerObj = mapConfig.getLayer(layer);
        if ( ! layerObj ) {
            return callback(new Error("layer index is greater than number of layers"));
        }
        if ( layerObj.type !== 'torque' ) {
            return callback(new Error("layer " + layer + " is not a torque layer"));
        }

        dbParams = Object.assign(dbParams, mapConfig.getLayerDatasource(layer));

        var pgSQL = sql(dbParams, this.sqlClass);
        fetchMapConfigAttributes(pgSQL, layerObj, function (err, params) {
            if (err) {
                return callback(err);
            }

            var RendererClass = formatToRenderer[format];

            callback(null, new RendererClass(layerObj, pgSQL, params, layer));
        });
    }
};

//
// given cartocss return javascript properties
//
// @param required optional array of required properties
//
// @throw Error if required properties are not found
//
function attrsFromCartoCSS(cartocss, required) {
  var attrs_keys = {
    '-torque-frame-count': 'steps',
    '-torque-resolution': 'resolution',
    '-torque-animation-duration': 'animationDuration',
    '-torque-aggregation-function': 'countby',
    '-torque-time-attribute': 'column',
    '-torque-data-aggregation': 'data_aggregation'
  };
  carto.tree.Reference.setData(torque_reference.version.latest);
  var env = {
      benchmark: false,
      validation_data: false,
      effects: [],
      errors: [],
      error: function(e) {
        this.errors.push(e);
      }
  };
  var symbolizers = torque_reference.version.latest.layer;
  var root = (carto.Parser(env)).parse(cartocss);
  var definitions = root.toList(env);
  var rules = getMapProperties(definitions, env);
  var attrs = {};
  for (var k in attrs_keys) {
    if (rules[k]) {
      attrs[attrs_keys[k]] = rules[k].value.toString();
      var element = rules[k].value.value[0];
      var type = symbolizers[k].type;
      if(!checkValidType(element, type)){
          throw new Error("Unexpected type for property '" + k + "', expected " + type);
      }
    } else if ( required && required.indexOf(attrs_keys[k]) !== -1 ) {
        throw new Error("Missing required property '" + k + "' in torque layer CartoCSS");
    }

  }
  return attrs;
}

function checkValidType(e, type){
    if (["number", "float"].indexOf(type) > -1) {
      return typeof e.value === "number";
    }
    else if (type === "string"){
      return e.value !== "undefined" && typeof e.value === "string";
    }
    else if (type.constructor === Array){
      return type.indexOf(e.value) > -1 || e.value === "linear";
    }
    else if (type === "color"){
      return checkValidColor(e);
    }
    return true;
}

function checkValidColor(e){
  var expectedArguments = { rgb: 3, hsl: 3, rgba: 4, hsla: 4};
  return typeof e.rgb !== "undefined" || expectedArguments[e.name] === e.args;
}


//
// get rules from Map definition
// stores errors in env.error
//
function getMapProperties(definitions, env) {
  var rules = {};
  definitions.filter(function(r) {
      return r.elements.join('') === 'Map';
  }).forEach(function(r) {
      for (var i = 0; i < r.rules.length; i++) {
          var key = r.rules[i].name;
          rules[key] = r.rules[i].ev(env);
      }
  });
  return rules;
}


//
// check layer and raise an exception is some error is found
//
// @throw Error if missing or malformed CartoCSS
//
function _checkLayerAttributes(layerConfig) {
  var cartoCSS = layerConfig.options.cartocss;
  if (!cartoCSS) {
    throw new Error("cartocss can't be undefined");
  }
  var checks = ['steps', 'resolution', 'column', 'countby'];
  return attrsFromCartoCSS(cartoCSS, checks);
}

// returns an array of errors if the mapconfig is not supported or contains errors
// errors is empty is the configuration is ok
// dbParams: host, dbname, user and pass
// layer: optional, if is specified only a layer is checked
function fetchMapConfigAttributes(sql, layer, callback) {
  // check attrs
  var attrs;
  try {
      attrs = _checkLayerAttributes(layer);
  }  catch (e) {
      return callback(e);
  }

  // fetch layer attributes to check the query and so on is ok
  var layer_sql = layer.options.sql;
  fetchLayerAttributes(sql, layer_sql, attrs, function(err, layerAttrs) {
    if (err) {
      return callback(err);
    }
    callback(null, Object.assign(attrs, layerAttrs));
  });
}

function fetchLayerAttributes(sql, layer_sql, attrs, callback) {
    layer_sql = SubstitutionTokens.replace(layer_sql, {
        bbox: 'ST_MakeEnvelope(0,0,0,0)',
        scale_denominator: '0',
        pixel_width: '1',
        pixel_height: '1'
    });

    // first step, fetch the schema to know if torque colum is time column
    const columnsQuery = `select * from (${layer_sql}) __torque_wrap_sql limit 0`;
    sql(columnsQuery, function (err, data) {
        // second step, get time bounds to calculate step
        if (err) {
            err.message = 'TorqueRenderer: ' + err.message;
            return callback(err);
        }

        if (!data) {
            debug(`ERROR: layer query '${layer_sql}' returned no data`);
            const noDataError = new Error("TorqueRenderer: Layer query returned no data");
            return callback(noDataError);
        }

        if (!data.fields.hasOwnProperty(attrs.column)) {
            debug(`ERROR: layer query ${layer_sql} does not include time-attribute column '${attrs.column}'`);
            const columnError = new Error(
                `TorqueRenderer: Layer query did not return the requested time-attribute column '${attrs.column}'`
            );
            return callback(columnError);
        }

        const is_time = data.fields[attrs.column].type === 'date';
        const stepQuery = getAttributesStepQuery(layer_sql, attrs.column, is_time);
        sql(stepQuery, function generateMetadata(err, data) {
            // prepare metadata needed to render the tiles
            if (err) {
                err.message = 'TorqueRenderer: ' + err.message;
                return callback(err);
            }

            data = data.rows[0];

            let attributeStep = (data.max_date - data.min_date + 1) / Math.min(attrs.steps, data.num_steps >> 0);
            attributeStep = Math.abs(attributeStep) === Infinity ? 0 : attributeStep;

            const attributes = {
                start: data.min_date,
                end: data.max_date,
                step: attributeStep || 1,
                data_steps: data.num_steps >> 0,
                is_time: is_time
            };

            callback(null, attributes);
        });
    });
}

function getAttributesStepQuery(layer_sql, column, is_time) {
    let max_col = `max(${column})`;
    let min_col = `min(${column})`;
    if (is_time) {
        max_col = `date_part('epoch', ${max_col})`;
        min_col = `date_part('epoch', ${min_col})`;
    }

    return `
        SELECT count(*) as num_steps, ${max_col} max_date, ${min_col} min_date
        FROM  (${layer_sql}) __torque_wrap_sql
    `;
}
