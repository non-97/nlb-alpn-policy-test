import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as fs from "fs";
import * as path from "path";

export class NlbStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const zoneName = "nlb.non-97.net";

    // Public Hosted Zone
    const publicHostedZone = new cdk.aws_route53.PublicHostedZone(
      this,
      "Public Hosted Zone",
      {
        zoneName,
      }
    );

    // NLB Access Log S3 Bucket
    const nlbAccessLogBucket = new cdk.aws_s3.Bucket(
      this,
      "NLB Access Log Bucket",
      {
        bucketName: "nlb-access-log-non-97",
        encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
        blockPublicAccess: new cdk.aws_s3.BlockPublicAccess({
          blockPublicAcls: true,
          blockPublicPolicy: true,
          ignorePublicAcls: true,
          restrictPublicBuckets: true,
        }),
        enforceSSL: true,
        autoDeleteObjects: true,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }
    );

    // Certificate
    const certificate = new cdk.aws_certificatemanager.Certificate(
      this,
      "Certificate",
      {
        domainName: zoneName,
        validation:
          cdk.aws_certificatemanager.CertificateValidation.fromDns(
            publicHostedZone
          ),
      }
    );

    //  VPC
    const vpc = new cdk.aws_ec2.Vpc(this, "VPC", {
      ipAddresses: cdk.aws_ec2.IpAddresses.cidr("10.0.0.0/24"),
      enableDnsHostnames: true,
      enableDnsSupport: true,
      maxAzs: 1,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: cdk.aws_ec2.SubnetType.PUBLIC,
          cidrMask: 27,
        },
        {
          name: "Isolated",
          subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 27,
        },
      ],
    });

    // S3 Gateway VPC Endpoint
    vpc.addGatewayEndpoint("S3 Gateway Endpoint", {
      service: cdk.aws_ec2.GatewayVpcEndpointAwsService.S3,
    });

    // SSM VPC Endpoint
    new cdk.aws_ec2.InterfaceVpcEndpoint(this, "SSM VPC Endpoint", {
      vpc: vpc,
      service: cdk.aws_ec2.InterfaceVpcEndpointAwsService.SSM,
      subnets: vpc.selectSubnets({
        subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED,
      }),
    });

    // SSM MESSAGES VPC Endpoint
    new cdk.aws_ec2.InterfaceVpcEndpoint(this, "SSM MESSAGES VPC Endpoint", {
      vpc: vpc,
      service: cdk.aws_ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      subnets: vpc.selectSubnets({
        subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED,
      }),
    });

    // EC2 MESSAGES VPC Endpoint
    new cdk.aws_ec2.InterfaceVpcEndpoint(this, "EC2 MESSAGES VPC Endpoint", {
      vpc: vpc,
      service: cdk.aws_ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
      subnets: vpc.selectSubnets({
        subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED,
      }),
    });

    // Security Group
    const webSg = new cdk.aws_ec2.SecurityGroup(this, "Web SG", {
      allowAllOutbound: true,
      vpc,
    });
    webSg.addIngressRule(cdk.aws_ec2.Peer.anyIpv4(), cdk.aws_ec2.Port.tcp(80));

    // User data for Nginx
    const userDataParameter = fs.readFileSync(
      path.join(__dirname, "../src/ec2/user_data_setting_httpd.sh"),
      "utf8"
    );
    const userDataSettingNginx = cdk.aws_ec2.UserData.forLinux({
      shebang: "#!/bin/bash",
    });
    userDataSettingNginx.addCommands(userDataParameter);

    // SSM IAM Role
    const ssmIamRole = new cdk.aws_iam.Role(this, "SSM IAM Role", {
      assumedBy: new cdk.aws_iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore"
        ),
      ],
    });

    // Web EC2 Instance
    const webEC2Instance = new cdk.aws_ec2.Instance(this, "Web EC2 Instance", {
      machineImage: cdk.aws_ec2.MachineImage.latestAmazonLinux({
        generation: cdk.aws_ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      instanceType: new cdk.aws_ec2.InstanceType("t3.micro"),
      vpc,
      vpcSubnets: vpc.selectSubnets({
        subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED,
      }),
      securityGroup: webSg,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: cdk.aws_ec2.BlockDeviceVolume.ebs(8, {
            volumeType: cdk.aws_ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
      propagateTagsToVolumeOnCreation: true,
      userData: userDataSettingNginx,
      role: ssmIamRole,
    });

    // NLB
    const nlb = new cdk.aws_elasticloadbalancingv2.NetworkLoadBalancer(
      this,
      "NLB",
      {
        vpc,
        crossZoneEnabled: true,
        internetFacing: true,
      }
    );
    nlb.logAccessLogs(nlbAccessLogBucket);

    const listener = nlb.addListener("listener", {
      port: 443,
      alpnPolicy: cdk.aws_elasticloadbalancingv2.AlpnPolicy.NONE,
      certificates: [certificate],
      protocol: cdk.aws_elasticloadbalancingv2.Protocol.TLS,
      sslPolicy: cdk.aws_elasticloadbalancingv2.SslPolicy.RECOMMENDED_TLS,
    });

    listener.addTargets("Targets", {
      targets: [
        new cdk.aws_elasticloadbalancingv2_targets.InstanceTarget(
          webEC2Instance,
          80
        ),
      ],
      protocol: cdk.aws_elasticloadbalancingv2.Protocol.TCP,
      port: 80,
    });

    // NLB Alias
    new cdk.aws_route53.ARecord(this, "NLB Alias Record", {
      zone: publicHostedZone,
      target: cdk.aws_route53.RecordTarget.fromAlias(
        new cdk.aws_route53_targets.LoadBalancerTarget(nlb)
      ),
    });
  }
}
