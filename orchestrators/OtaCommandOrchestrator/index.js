﻿// Durable function orchestrator
/*
 * This function is not intended to be invoked directly. Instead it will be
 * triggered by a starter function and progressed by client functions.
 */

const df = require('durable-functions');
const uuid = require('uuid').v4;
//const { getFunctionName } = require('../SharedCode');

const testMode = process.env.testMode;
const funcName = 'OtaCommandOrchestrator';

module.exports = df.orchestrator(function* (context) {
  try {
    //const funcName = getFunctionName(__filename);
    let outputs = [];
    const input = context.df.getInput();
    input.data.otaCommandId = input.id;
    if (input && input.data) {
      context.log.verbose(`${funcName} orchestrating command ${input.id}:` +
          ` ${JSON.stringify(input.data)}`);
      const mobileId = input.data.mobileId;
      const commandMeta = input.subject;
      context.df.setCustomStatus({
        state: 'submitting',
        mobileId: mobileId,
      });
      
      // 1. Submit command as OTA message and get message ID
      const submissionId =
          yield context.df.callActivity("OtaCommandSubmit", input.data);
      context.df.setCustomStatus({
        state: 'submitted',
        mobileId: mobileId,
        submissionId: submissionId,
      });
      context.log.verbose(`OtaCommandSending waiting for NewForwardMessage` +
          ` with submissionId: ${submissionId}`);
      const { messageId } =
          yield context.df.waitForExternalEvent('CommandSending');
      context.df.setCustomStatus({
        state: 'sending',
        mobileId: mobileId,
        messageId: messageId,
      });
      outputs.push({ commandMessageId: messageId });
      
      // 2. ForwardMessageStateChange captured by OtaCommandDelivery function
      context.log.verbose(`OtaCommandSending sent messageId: ${messageId}` +
          ` OtaCommandDelivery now awaiting ForwardMessageStateChange`);
      const delivered =
          yield context.df.waitForExternalEvent('CommandDelivered');
      context.log.verbose(`${funcName} received CommandDelivered` +
          ` with ${JSON.stringify(delivered)}`);
      context.df.setCustomStatus({
        state: delivered.success ? 'delivered' : 'failed',
        mobileId: mobileId,
        deliveryTime: delivered.deliveryTime,
      });
      let completionEvent = {
        id: uuid(),
        dataVersion: '2.0',
        data: Object.assign({}, input.data),
        eventType = 'OtaCommandComplete',
        eventTime = delivered.deliveryTime,
      };
      delete completionEvent.data.command;
      if (delivered.success) {
        context.log.verbose(`Command ${input.data.otaCommandId} delivered`);
        completionEvent.subject = `Command delivered: ${commandMeta}`;
        completionEvent.data.commandDeliveredTime = delivered.deliveryTime;
        outputs.push({ commandDeliveredTime: delivered.deliveryTime });
      } else {
        context.log.warn(`Command ${input.data.otaCommandId} failed`)
        completionEvent.subject = `Command failed: ${commandMeta}`;
        completionEvent.data.commandFailedTime = delivered.deliveryTime;
        outputs.push({
          commandFailedTime: delivered.deliveryTime,
          reason: delivered.reason,
        });
      }
      context.log.info(`${funcName} publishing` +
          ` ${JSON.stringify(completionEvent)} for Device Bridge`);
      if (!testMode) {
        context.bindings.outputEvent = completionEvent;
      }
      outputs.push({ completionEventPublished: completionEvent.id });
    }
  
    /* TODO: future feature for response to commands
    if (input.data.completion.response) {
      context.log.warn('Response event untested...');
      // Wait for event NewReturnMessage with expectedResponse identifier(s)
      const { codecServiceId, codecMessageId } = input.data.completion.response;
      context.df.setCustomStatus({
        state: 'awaitingResponse',
        mobileId: mobileId,
        codecServiceId: codecServiceId,
        codecMessageId: codecMessageId,
      });
      // NewReturnMessage captured/filtered by OtaResponseReceived
      context.log.verbose(`${funcName} awaiting ResponseReceived`
          + `(codecServiceId:${codecServiceId}`
          + ` | codecMessageId:${codecMessageId})`);
      const response =
          yield context.df.waitForExternalEvent('ResponseReceived');
      responseEvent = {
        id: uuid(),
        dataVersion: '2.0',
        subject: `Command response to ${commandMeta}`,
        eventType: 'OtaCommandResponse',
        data: Object.assign({ otaCommandId: input.id }, response),
        eventTime: response.receiveTimeUtc,
      }
      context.log.info(`${funcName} publishing ${JSON.stringify(responseEvent)}` +
          ` for Device Bridge`);
      if (!testMode) {
        context.bindings.outputEvent = responseEvent;
      }
      outputs.push({ responseEventPublished: responseEvent.id });
    }
    // */
  
    context.log.verbose(`${funcName} outputs:` +
        ` ${JSON.stringify(outputs)}`);
    for (let i=0; i < outputs.length; i++) {
      if ('commandFailedTime' in outputs[i]) {
        context.log.warn(`Command ${input.data.otaCommandId} failed` +
            ` (${outputs[i].reason})` +
            ` at ${outputs[i].commandFailedTime}`);
      }
    }
    return outputs;
  } catch (e) {
    context.log.error(e.toString());
  }
});