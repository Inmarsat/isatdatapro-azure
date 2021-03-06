// IoT Central REST API calls for Device Templates

// Get templates, compare against this lib; upload new from lib
const https = require('https')
const { interfaces, templates } = require('./deviceTemplates');

let tempEnv;
if (!process.env.IOTC_APPLICATION_URL) {
  const { IOTC_APPLICATION_URL, IOTC_BUILDER_TOKEN } =
      require('../local.settings.json').Values;
  tempEnv = {
    IOTC_APPLICATION_URL: IOTC_APPLICATION_URL,
    IOTC_BUILDER_TOKEN: IOTC_BUILDER_TOKEN,
  };
}

const apiHost = process.env.IOTC_APPLICATION_URL || tempEnv.IOTC_APPLICATION_URL;
const apiKey = process.env.IOTC_BUILDER_TOKEN || tempEnv.IOTC_BUILDER_TOKEN;
const deviceApiPath = '/api/devices';
const deviceTemplateApiPath = '/api/deviceTemplates';
const apiVersion = '1.0';

/**
 * Intefaces to the IoT Central REST API
 * @private
 * @param {Object} options Request options including path, method
 * @param {string} reqBody The body content as a string
 * @returns {Promise}
 */
const api = (options, reqBody) => new Promise((resolve, reject) => {
  let postData;
  options.path += `?api-version=${apiVersion}`;
  options.hostname = `${apiHost}`;
  options.headers = {
    'Content-Type': 'application/json',
    'Authorization': `${apiKey}`
  };
  if (reqBody) {
    postData = JSON.stringify(reqBody);
    options.headers['Content-Length'] = Buffer.byteLength(postData);
  }
  const req = https.request(options, (res) => {
    let resBody = '';
    res.on('data', (chunk) => resBody += chunk);
    res.on('end', () => resolve(resBody));
  });
  req.on('error', (e) => { reject(e) });
  if (reqBody) req.write(postData);
  req.end();
})

/**
 * Retrieves all devices from the application
 * @returns {Object[]} A list of devices
 */
async function listDevices() {
  const deviceOptions = {
    path: `${deviceApiPath}`,
    method: 'GET',
  };
  const res = JSON.parse(await api(deviceOptions));
  if (res.error) throw new Error(res.error);
  return res.value;
}

/**
 * Returns properties of a specific device
 * @param {string} id The unique ID of the device in IoT Central
 * @returns {Object} the properties
 */
async function getDeviceProperties(id) {
  if (!id) throw new Error(`Missing device unique id`);
  const getPropOptions = {
    path: `${deviceApiPath}/${id}/properties`,
    method: 'GET',
  };
  const res = JSON.parse(await api(getPropOptions));
  if (res.error) throw new Error(res.error);
  return res;
}

/**
 * Returns a word-formatted string from snake_ or camelCase
 * @private
 * @param {string} uglyName The name to convert to pretty
 * @returns {string}
 */
function prettyName(uglyName) {
  let camelCase = uglyName.replace(/([_][a-z])/ig, ($1) => {
    return $1.toUpperCase().replace('_', '');
  });
  let toWords = camelCase.replace(/([A-Z])/g, ($1) => {
    return ` ${$1}`;
  });
  return toWords[0].toUpperCase() + toWords.substring(1);
}

/**
 * Creates an IOT Central template from a Device Capability Model
 * @param {Object} capabilityModel A device capability model DTDL v1
 * @returns {Object} the template wrapper to send to the API
 */
function buildTemplate(template) {
  if (!template.capabilityModel) {
    throw new Error('Template missing capabilityModel');
  }
  if (!template['@id'] || !template['@id'].includes('modelDefinition')) {
    throw new Error('Template missing unique @id for modelDefinition');
  }
  if (!template.displayName) {
    throw new Error('Template missing displayName');
  }
  const capabilityModel = template.capabilityModel;
  if (capabilityModel['@type'] !== 'Interface') {
    throw new Error('Template capabilityModel missing parent Interface');
  }
  if (capabilityModel.extends) {
    for (let e = 0; e < capabilityModel.extends.length; e++) {
      let component = capabilityModel.extends[e];
      // TODO: validate @id, @type, name, displayName, schema
      if (component['@type'] === 'Component') {
        for (const interfaceName in interfaces) {
          const interface = interfaces[interfaceName];
          if (component.schema === interface['@id']) {
            template.capabilityModel.extends[e].schema = interface;
            break;
          }
        }
      }
    }
  }
  if (capabilityModel.contents) {
    for (let c=0; c < capabilityModel.contents.length; c++) {
      let component = capabilityModel.contents[c];
      // TODO: validate @id, @type, name, displayName, schema
      if (component['@type'] === 'Component') {
        for (const interfaceName in interfaces) {
          const interface = interfaces[interfaceName];
          if (component.schema === interface['@id']) {
            template.capabilityModel.contents[c].schema = interface;
            break;
          }
        }
      }
    }
  }
  return template;
}

/**
 * Provisions a device template in IoT Central
 * @param {Object} template A DTDLv1 device capability model
 * @returns {string} template ID
 */
async function setDeviceTemplate(template) {
  const extendedTemplate = buildTemplate(template);
  const capabilityModelId = extendedTemplate['@id'] || extendedTemplate.capabilityModel['@id'];
  const templateId =
      capabilityModelId.replace('CapabilityModel', 'DeviceTemplate');
  const setOptions = {
    path: `${deviceTemplateApiPath}/${templateId}`,
    method: 'PUT',
  };
  const res = JSON.parse(await api(setOptions, extendedTemplate));
  if (res.error) {
    throw new Error(res.error.message);
  }
  return res.etag;
}

/**
 * 
 * @param {Object} template 
 */
async function removeDeviceTemplate(template) {
  const removeOptions = {
    path: `${deviceTemplateApiPath}/${template['@id']}`,
    method: 'DELETE',
  };
  const res = JSON.parse(await api(removeOptions));
  if (res.error) {
    throw new Error(res.error.message);
  }
  return res.approved;
}

/**
 * Retrieves provisioned device templates from IoT Central application
 * @returns {Object[]} list
 */
async function listDeviceTemplates() {
  const getOptions = {
    path: `${deviceTemplateApiPath}`,
    method: 'GET',
  };
  const res = JSON.parse(await api(getOptions));
  if (res.error) {
    throw new Error(res.error);
  }
  return res.value;
}

async function updateDeviceTemplates(context) {
  const repoTemplates = Object.assign({}, templates);
  const centralTemplates = await listDeviceTemplates();
  for (const templateName in repoTemplates) {
    const repoTemplate = repoTemplates[templateName];
    for (let i=0; i < centralTemplates.length; i++) {
      const centralTemplate = centralTemplates[i];
      if (repoTemplate.id) {
        // context.log.warn(`${templateName} is old DTDLv1`);
        if (repoTemplate.id === centralTemplate['@id']) {
          delete repoTemplates[templateName];
        }
      }
      if (repoTemplate['@id'] === centralTemplate['@id']) {
        delete repoTemplates[templateName];
        break;
      }
    }
  }
  for (const templateName in repoTemplates) {
    await setDeviceTemplate(repoTemplates[templateName]);
    context.log(`Updated device template ${templateName}`);
  }
}

/**
 * Returns the Mobile ID from a provisioned device ID
 * @private
 * @param {string} deviceId Unique provisioned device ID containing Mobile ID
 * @returns {string} mobileId
 */
 function extractMobileId(deviceId) {
  const manufacturerCodes = ['SKY', 'HON'];
  let mobileId;
  for (let m=0; m < manufacturerCodes.length; m++) {
    if (deviceId.includes(manufacturerCodes[m])) {
      const index = deviceId.search(manufacturerCodes[m]);
      mobileId = deviceId.substring(index - 8, index + 7);
      break;
    }
  }
  return mobileId;
}

/**
 * Looks up the provisioned device template for a device based on the 
 * IDP Mobile ID to map to a device model
 * @param {string} mobileId Unique satellite modem ID
 * @returns {{ id: string, model: string, mobileId: string }}
 */
 async function getDeviceMeta(mobileId) {
  const provisionedDevices = await listDevices();
  let device;
  for (let d=0; d < provisionedDevices.length; d++) {
    if (provisionedDevices[d].id.includes(mobileId)) {
      for (let template in templates) {
        if (templates[template]['@id'] === provisionedDevices[d].template) {
          device = {
            id: provisionedDevices[d].id,
            modelName: template,
            mobileId: mobileId,
          };
          break;
        }
      }
    }
    if (device) break;
  }
  return device;
}

module.exports = {
  listDevices,
  getDeviceProperties,
  listDeviceTemplates,
  setDeviceTemplate,
  removeDeviceTemplate,
  buildTemplate,
  updateDeviceTemplates,
  extractMobileId,
  getDeviceMeta,
};
