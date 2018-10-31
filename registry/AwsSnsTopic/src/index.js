const {
  concat,
  contains,
  equals,
  filter,
  find,
  head,
  isNil,
  keys,
  map,
  merge,
  reduce,
  values,
  resolve
} = require('@serverless/utils')

const DEPLOY = 'deploy'
const REPLACE = 'replace'

const capitalize = (string) => `${string.charAt(0).toUpperCase()}${string.slice(1)}`
const resolveInSequence = async (functionsToExecute) =>
  reduce(
    (promise, functionToExecute) =>
      promise.then((result) => functionToExecute().then(Array.prototype.concat.bind(result))),
    Promise.resolve([]),
    functionsToExecute
  )

const createSNSTopic = async (
  sns,
  { topicName, displayName, policy, deliveryPolicy, deliveryStatusAttributes }
) => {
  const { TopicArn: topicArn } = await sns.createTopic({ Name: topicName }).promise()
  // save topic if attribute update fails
  const topicAttributes = await updateAttributes(
    sns,
    {
      displayName,
      policy,
      deliveryPolicy,
      deliveryStatusAttributes,
      topicArn
    },
    {}
  )
  return merge({ topicArn, topicName }, topicAttributes)
}

const concatInputsAndState = (inputs, state = []) => {
  const attributeKeys = map((item) => head(keys(item)), inputs)
  return filter((item) => isNil(find(equals(item))(state)))(
    concat(
      inputs,
      reduce(
        (attributes, attribute) => {
          const key = head(keys(attribute))
          if (!contains(key, attributeKeys)) {
            // return empty string to "unset" removed value
            return concat(attributes, [{ [key]: '' }])
          }
          return attributes
        },
        [],
        state
      )
    )
  )
}

const updateAttributes = async (
  sns,
  { displayName, policy, deliveryPolicy, deliveryStatusAttributes = [], topicArn },
  prevInstance
) => {
  const topicAttributes = reduce(
    (result, value) => {
      if (head(values(value))) {
        return concat(result, [value])
      }
      return result
    },
    [],
    [{ displayName }, { policy }, { deliveryPolicy }]
  )

  const prevInstanceTopicAttributes = filter((item) => !isNil(head(values(item))))([
    { displayName: prevInstance.displayName },
    { policy: prevInstance.policy },
    { deliveryPolicy: prevInstance.deliveryPolicy }
  ])

  // combine inputs and check if something is removed
  const topicAttributesToUpdate = concatInputsAndState(topicAttributes, prevInstanceTopicAttributes)

  await updateTopicAttributes(sns, { topicAttributes: topicAttributesToUpdate, topicArn })

  // flatten delivery status attributes array
  const flatDeliveryStatusAttributes = reduce(
    (result, attribute) =>
      concat(result, map((key) => ({ [key]: attribute[key] }), keys(attribute))),
    [],
    deliveryStatusAttributes
  )

  // combine inputs and check if something is removed and select only ones that differs in state and inputs
  const deliveryStatusAttributesToUpdate = concatInputsAndState(
    flatDeliveryStatusAttributes,
    prevInstance.deliveryStatusAttributes
  )

  // update delivery status attributes
  await updateDeliveryStatusAttributes(sns, {
    deliveryStatusAttributes: deliveryStatusAttributesToUpdate,
    topicArn
  })

  return merge(
    reduce(
      (result, value) => merge({ [head(keys(value))]: head(values(value)) }, result),
      {},
      topicAttributes
    ),
    { deliveryStatusAttributes: flatDeliveryStatusAttributes }
  )
}

const updateTopicAttributes = async (sns, { topicAttributes, topicArn }) =>
  Promise.all(
    map((topicAttribute) => {
      const value = head(values(topicAttribute))
      const params = {
        TopicArn: topicArn,
        AttributeName: capitalize(head(keys(topicAttribute))),
        AttributeValue: typeof value !== 'string' ? JSON.stringify(value) : value
      }
      return sns.setTopicAttributes(params).promise()
    }, topicAttributes)
  )

const updateDeliveryStatusAttributes = async (sns, { deliveryStatusAttributes, topicArn }) =>
  // run update requests sequentially because setTopicAttributes
  // fails to update when rate exceeds https://github.com/serverless/components/issues/174#issuecomment-390463523
  resolveInSequence(
    map(
      (topicAttribute) => () => {
        const value = head(values(topicAttribute))
        const params = {
          TopicArn: topicArn,
          AttributeName: capitalize(head(keys(topicAttribute))),
          AttributeValue: typeof value !== 'string' ? JSON.stringify(value) : value
        }
        return sns.setTopicAttributes(params).promise()
      },
      deliveryStatusAttributes
    )
  )

const AwsSnsTopic = (SuperClass) =>
  class extends SuperClass {
    async construct(inputs, context) {
      await super.construct(inputs, context)

      this.provider = inputs.provider || context.get('provider')
      this.topicName = inputs.topicName || `sns-${this.instanceId}`
      this.displayName = inputs.displayName
      this.policy = inputs.policy
      this.deliveryPolicy = inputs.deliveryPolicy
      this.deliveryStatusAttributes = inputs.deliveryStatusAttributes
    }

    shouldDeploy(prevInstance) {
      if (!prevInstance) {
        return DEPLOY
      }
      if (prevInstance.topicName !== this.topicName || prevInstance.policy !== this.policy) {
        return REPLACE
      }
    }

    async deploy(prevInstance, context) {
      const provider = this.provider
      const AWS = provider.getSdk()
      const sns = new AWS.SNS()

      if (prevInstance && prevInstance.topicName === resolve(this.topicName)) {
        context.log(`Updating SNS topic: '${this.topicName}'...`)
        const props = merge(
          await updateAttributes(
            sns,
            merge({ topicArn: prevInstance.topicArn }, this),
            prevInstance
          ),
          {
            name: this.topicName,
            topicArn: prevInstance.topicArn
          }
        )
        Object.assign(this, props)
        context.log(`SNS Topic '${this.topicName}' Updated.`)
      } else {
        context.log(`Creating SNS topic: '${this.topicName}'...`)
        const props = await createSNSTopic(sns, this)
        Object.assign(this, props)
        context.log(`SNS Topic '${this.topicName}' Created.`)
      }
    }

    async remove(context) {
      const provider = this.provider
      const AWS = provider.getSdk()
      const sns = new AWS.SNS()
      context.log(`Removing SNS topic: '${this.topicName}'`)
      await sns
        .deleteTopic({
          TopicArn: this.topicArn
        })
        .promise()
      context.log(`SNS topic '${this.topicName}' removed.`)
    }

    async info() {
      return {
        title: this.topicName,
        type: this.extends,
        data: {
          topicName: this.topicName,
          arn: this.topicArn
        }
      }
    }
  }

export default AwsSnsTopic
